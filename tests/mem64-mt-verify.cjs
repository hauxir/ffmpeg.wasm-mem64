/**
 * Verify the multi-thread (pthreads) memory64 core: packages/core-mt-64.
 * Run on a runtime with SharedArrayBuffer + threads (node:24).
 *
 *   node tests/mem64-mt-verify.cjs
 */
const fs = require("fs");
const path = require("path");

const PKG = path.join(__dirname, "..", "packages", "core-mt-64");
const UMD_DIR = path.join(PKG, "dist", "umd");
const WASM = path.join(UMD_DIR, "ffmpeg-core.wasm");

if (typeof globalThis.self === "undefined") globalThis.self = globalThis;
if (typeof globalThis.location === "undefined")
  globalThis.location = { href: "file://" + UMD_DIR + "/ffmpeg-core.js" };
// The MT core spawns pthreads via the Web `Worker` API (it's built for a browser
// worker). Node has no global Worker, so map it onto node's worker_threads using
// the `web-worker` polyfill — lets us run-test the same artifact under node.
if (typeof globalThis.Worker === "undefined") {
  try { globalThis.Worker = require("web-worker"); } catch (_) {}
}

// --- static: 64-bit AND shared memory? ---
function memFlags() {
  const b = fs.readFileSync(WASM);
  let pos = 8;
  const uleb = () => { let r = 0n, s = 0n, x; do { x = b[pos++]; r |= BigInt(x & 127) << s; s += 7n; } while (x & 128); return r; };
  while (pos < b.length) {
    const id = b[pos++]; const sz = Number(uleb()); const end = pos + sz;
    if (id === 2) { // import section
      const n = Number(uleb());
      for (let i = 0; i < n; i++) {
        const ml = Number(uleb()); pos += ml;
        const fl = Number(uleb()); pos += fl;
        const kind = b[pos++];
        if (kind === 2) { return Number(uleb()); }      // memory import -> limits flags
        else if (kind === 0) { uleb(); }
        else if (kind === 1) { pos++; const f = Number(uleb()); uleb(); if (f & 1) uleb(); }
        else if (kind === 3) { pos += 2; }
      }
    } else if (id === 5) { const c = Number(uleb()); return Number(uleb()); }
    pos = end;
  }
  return -1;
}

(async () => {
  const f = memFlags();
  console.log(`[static] memory limits flags=0x${f.toString(16)}  64-bit=${!!(f & 4)}  shared=${!!(f & 2)}`);
  console.log(`[static] ffmpeg-core.wasm = ${(fs.readFileSync(WASM).length / 1e6).toFixed(1)} MB`);

  const t0 = Date.now();
  const core = await require(PKG)({ wasmBinary: fs.readFileSync(WASM), locateFile: (p) => path.join(UMD_DIR, p) });
  console.log(`[load] core + pthread pool initialised in ${((Date.now() - t0) / 1000).toFixed(1)}s ✓`);

  let logs = [];
  core.setLogger(({ message }) => { if (message != null) logs.push(message); });
  core.setProgress(() => {});
  const results = [];
  const V = ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=2"];
  const A = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.3"];
  const enc = (label, args, out) => {
    core.reset(); logs = [];
    let status = "FAIL", detail = "";
    try {
      const ret = core.exec(...args);
      if (ret !== 0) { detail = `ret=${ret}; ${logs.slice(-3).join(" | ")}`; }
      else { const o = core.FS.readFile(out); core.FS.unlink(out); status = o.length > 0 ? "PASS" : "FAIL"; detail = `${o.length} bytes`; }
    } catch (e) { status = "ERROR"; detail = e.message; }
    console.log(`[run] ${label.padEnd(14)} ${status.padEnd(5)} ${status === "PASS" ? "✓" : "✗"}  ${detail}`);
    results.push({ label, status });
  };

  enc("x264 (H.264)", [...V, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "o.mp4"], "o.mp4");
  enc("aac",         [...A, "-c:a", "aac", "o.m4a"], "o.m4a");
  enc("h264+aac",    [...V, "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "av.mp4"], "av.mp4");
  // bonus: x265 may work in MT (it has a real thread pool here, unlike the ST core)
  enc("x265 (HEVC)", [...V, "-c:v", "libx265", "-preset", "ultrafast", "o.mkv"], "o.mkv");

  const bad = results.filter((r) => r.status !== "PASS");
  console.log(`\nSUMMARY: ${results.filter(r => r.status === "PASS").length}/${results.length} PASS`);
  process.exit(bad.some((r) => ["x264 (H.264)", "aac", "h264+aac"].includes(r.label)) ? 1 : 0);
})().catch((e) => { console.error("MT VERIFY FAILED:", e && e.stack || e); process.exit(1); });
