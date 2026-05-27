/**
 * Verification harness for the memory64 (wasm64) ffmpeg core.
 *
 * Run with:  node tests/mem64-verify.cjs
 *
 * It does two independent things:
 *   1. Parses packages/core-64/dist/.../ffmpeg-core.wasm and asserts that its
 *      linear memory is declared 64-bit (the Memory64 flag bit, 0x04, is set on
 *      the memory's limits). This proves the binary is genuinely wasm64 and not
 *      an accidental wasm32 build.
 *   2. Loads the core in Node (V8 runs Memory64 by default here) and runs real
 *      ffmpeg commands:
 *        - exec("-h")            -> exercises the 64-bit argv pointer array
 *        - libx264 encode        -> end-to-end transcode using the wasm64 x264
 *        - libmp3lame encode     -> end-to-end audio using the wasm64 lame
 */
const fs = require("fs");
const path = require("path");

const PKG = path.join(__dirname, "..", "packages", "core-64");
const UMD_DIR = path.join(PKG, "dist", "umd");

// The core is built with `-sENVIRONMENT=worker` (its real target is a browser
// Web Worker), so its bootstrap references the worker globals `self` and
// `self.location.href` at load time. Alias them to globalThis so we can
// smoke-test the same artifact under Node's main thread.
if (typeof globalThis.self === "undefined") globalThis.self = globalThis;
if (typeof globalThis.location === "undefined") {
  globalThis.location = { href: "file://" + UMD_DIR + "/ffmpeg-core.js" };
}
const WASM = path.join(PKG, "dist", "umd", "ffmpeg-core.wasm");

/* ---------- 1. static check: is the wasm memory 64-bit? ---------- */

function readULEB(buf, pos) {
  let result = 0n;
  let shift = 0n;
  let byte;
  do {
    byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while (byte & 0x80);
  return [result, pos];
}

// Returns {kind, flags} for the module's (first) linear memory, scanning both
// the import section (id 2) and the memory section (id 5).
function findMemoryFlags(buf) {
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error("not a wasm module");
  let pos = 8; // skip magic + version
  while (pos < buf.length) {
    const id = buf[pos++];
    let size;
    [size, pos] = readULEB(buf, pos);
    const end = pos + Number(size);
    if (id === 5) {
      // memory section: count, then [flags, min, (max)]
      let count;
      [count, pos] = readULEB(buf, pos);
      if (count > 0n) {
        let flags;
        [flags, pos] = readULEB(buf, pos);
        return { kind: "defined", flags: Number(flags) };
      }
    } else if (id === 2) {
      // import section: look for an imported memory (extern kind 0x02)
      let count;
      [count, pos] = readULEB(buf, pos);
      let p = pos;
      for (let i = 0; i < Number(count); i++) {
        let mlen;
        [mlen, p] = readULEB(buf, p);
        p += Number(mlen); // module name
        let flen;
        [flen, p] = readULEB(buf, p);
        p += Number(flen); // field name
        const kind = buf[p++];
        if (kind === 0x02) {
          let flags;
          [flags, p] = readULEB(buf, p);
          return { kind: "imported", flags: Number(flags) };
        } else if (kind === 0x00) {
          // function: typeidx
          [, p] = readULEB(buf, p);
        } else if (kind === 0x01) {
          // table: reftype + limits
          p++; // reftype
          let lf;
          [lf, p] = readULEB(buf, p);
          [, p] = readULEB(buf, p); // min
          if (Number(lf) & 0x01) [, p] = readULEB(buf, p); // max
        } else if (kind === 0x03) {
          // global: valtype + mutability
          p += 2;
        }
      }
    }
    pos = end;
  }
  throw new Error("no memory found in module");
}

function staticCheck() {
  if (!fs.existsSync(WASM)) {
    console.error(`MISSING: ${WASM}\n  (build first with: make prd-64)`);
    process.exit(2);
  }
  const buf = fs.readFileSync(WASM);
  const { kind, flags } = findMemoryFlags(buf);
  const is64 = (flags & 0x04) !== 0;
  console.log(
    `[static] ${kind} memory, limits flags=0x${flags.toString(16)} -> ` +
      `${is64 ? "64-bit (Memory64 ✓)" : "32-bit (NOT wasm64 ✗)"}`
  );
  console.log(`[static] ffmpeg-core.wasm size = ${(buf.length / 1e6).toFixed(1)} MB`);
  if (!is64) {
    console.error("FAIL: memory is not 64-bit");
    process.exit(1);
  }
  return true;
}

/* ---------- 2. runtime check: does it actually run? ---------- */

async function runtimeCheck() {
  const createFFmpegCore = require(PKG);
  // Hand the wasm bytes in directly so the worker-targeted runtime never tries
  // to fetch() the .wasm (Node's fetch won't load file:// URLs).
  const core = await createFFmpegCore({
    wasmBinary: fs.readFileSync(WASM),
    locateFile: (p) => path.join(UMD_DIR, p),
  });
  let logs = [];
  core.setLogger(({ message }) => logs.push(message));
  core.setProgress(() => {});

  const run = (label, args, expect = 0) => {
    core.reset();
    logs = [];
    let ret;
    try {
      ret = core.exec(...args);
    } catch (e) {
      console.error(`[run] ${label} threw: ${e.message}`);
      console.error(e.stack);
      throw e;
    }
    const ok = ret === expect;
    console.log(`[run] ${label}: exec(${args.join(" ")}) -> ret=${ret} ${ok ? "✓" : "✗"}`);
    if (!ok) {
      console.error(logs.slice(-15).join("\n"));
      throw new Error(`${label} failed (ret=${ret})`);
    }
  };

  // Encode helper: run a command and assert it produced a non-empty file.
  const encode = (label, args, outFile) => {
    run(label, args);
    const out = core.FS.readFile(outFile);
    console.log(`[run]   -> ${outFile} = ${out.length} bytes ${out.length > 0 ? "✓" : "✗"}`);
    if (out.length === 0) throw new Error(`${label} produced empty ${outFile}`);
    core.FS.unlink(outFile);
  };

  // -h drives the 64-bit argv pointer array in bind.js.
  run("help", ["-h"]);

  // A tiny built-in test pattern (2 frames, 64x64) reused as the video source
  // for each encoder. Kept minimal because single-thread wasm encoding (esp.
  // x265/VP9) is slow — we only need to prove the codec runs, not benchmark it.
  const V = ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=2"];
  const A = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.3"];

  // --- video codecs ---
  encode("x264  (H.264)", [...V, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "out.mp4"], "out.mp4");
  encode("x265  (HEVC)",  [...V, "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "out.mkv"], "out.mkv");
  encode("vpx   (VP9)",   [...V, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "out.webm"], "out.webm");
  encode("theora",        [...V, "-c:v", "libtheora", "out.ogv"], "out.ogv");
  encode("libwebp",       [...V, "-c:v", "libwebp", "-frames:v", "1", "out.webp"], "out.webp");
  // zimg via the zscale filter (resize), proves libzimg is wired in.
  encode("zimg (zscale)", [...V, "-vf", "zscale=32:32", "-c:v", "libx264", "-preset", "ultrafast", "out2.mp4"], "out2.mp4");

  // --- audio codecs ---
  encode("lame  (MP3)",   [...A, "-c:a", "libmp3lame", "out.mp3"], "out.mp3");
  encode("opus",          [...A, "-c:a", "libopus", "out.opus"], "out.opus");
  encode("vorbis",        [...A, "-c:a", "libvorbis", "out.ogg"], "out.ogg");

  console.log("\nALL CHECKS PASSED — full-parity wasm64 ffmpeg core works end-to-end.");
}

(async () => {
  staticCheck();
  await runtimeCheck();
})().catch((e) => {
  console.error("\nVERIFICATION FAILED:");
  console.error(e);
  process.exit(1);
});
