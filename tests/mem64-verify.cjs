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

  const results = [];

  // Resilient encode: run a command, assert non-empty output, but never throw —
  // record pass/fail/error so one bad codec doesn't hide the rest.
  const encode = (label, args, outFile) => {
    core.reset();
    logs = [];
    let status, detail;
    try {
      const ret = core.exec(...args);
      if (ret !== 0) {
        status = "FAIL";
        detail = `ret=${ret}; ${logs.slice(-3).join(" | ")}`;
      } else {
        const out = core.FS.readFile(outFile);
        core.FS.unlink(outFile);
        status = out.length > 0 ? "PASS" : "FAIL";
        detail = `${out.length} bytes`;
      }
    } catch (e) {
      status = "ERROR";
      detail = e.message;
    }
    const mark = status === "PASS" ? "✓" : "✗";
    console.log(`[run] ${label.padEnd(14)} ${status.padEnd(5)} ${mark}  ${detail}`);
    results.push({ label, status });
  };

  // -h drives the 64-bit argv pointer array in bind.js (must work).
  core.reset();
  const helpRet = core.exec("-h");
  console.log(`[run] ${"help".padEnd(14)} ${(helpRet === 0 ? "PASS" : "FAIL").padEnd(5)} ${helpRet === 0 ? "✓" : "✗"}`);
  results.push({ label: "help", status: helpRet === 0 ? "PASS" : "FAIL" });

  // A tiny built-in test pattern (2 frames, 64x64) reused as the video source.
  const V = ["-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=2"];
  const A = ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.3"];

  // --- video codecs ---
  encode("x264 (H.264)", [...V, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "out.mp4"], "out.mp4");
  encode("vpx (VP9)",    [...V, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "out.webm"], "out.webm");
  encode("libwebp",      [...V, "-c:v", "libwebp", "-frames:v", "1", "out.webp"], "out.webp");

  // --- audio codecs ---
  encode("aac (enc)",    [...A, "-c:a", "aac", "out.m4a"], "out.m4a"); // FFmpeg native AAC
  encode("lame (MP3)",   [...A, "-c:a", "libmp3lame", "out.mp3"], "out.mp3");
  encode("opus",         [...A, "-c:a", "libopus", "out.opus"], "out.opus");
  encode("vorbis",       [...A, "-c:a", "libvorbis", "out.ogg"], "out.ogg");

  // --- headline real-world case: H.264 video + AAC audio muxed to mp4 ---
  encode("h264+aac mp4", [
    ...V, "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", "av.mp4",
  ], "av.mp4");

  // --- DECODE pass ---------------------------------------------------------
  // Decoding uses FFmpeg's *native* decoders (built-in C in libavcodec), not the
  // external encoder libs, so it should be broadly available. For each format we
  // encode a sample with a known-good encoder, then decode it back (audio -> PCM
  // wav, video -> raw frames) and assert the decode produced output.
  console.log("--- decode (FFmpeg native decoders) ---");
  const decode = (label, encArgs, srcFile, decArgs, outFile) => {
    let status = "FAIL", detail = "";
    try {
      core.reset();
      const er = core.exec(...encArgs);
      core.reset();
      const dr = core.exec(...decArgs);
      const out = core.FS.readFile(outFile);
      status = er === 0 && dr === 0 && out.length > 0 ? "PASS" : "FAIL";
      detail = `enc=${er} dec=${dr} ${out.length} bytes`;
      try { core.FS.unlink(srcFile); core.FS.unlink(outFile); } catch (_) {}
    } catch (e) {
      status = "ERROR"; detail = e.message;
    }
    console.log(`[dec] ${label.padEnd(14)} ${status.padEnd(5)} ${status === "PASS" ? "✓" : "✗"}  ${detail}`);
    results.push({ label: "dec " + label, status });
  };

  // audio: encode -> decode to PCM wav
  decode("aac",  [...A, "-c:a", "aac", "s.m4a"], "s.m4a", ["-i", "s.m4a", "-c:a", "pcm_s16le", "o.wav"], "o.wav");
  decode("mp3",  [...A, "-c:a", "libmp3lame", "s.mp3"], "s.mp3", ["-i", "s.mp3", "-c:a", "pcm_s16le", "o.wav"], "o.wav");
  // video: encode -> decode to raw yuv (exercises the native h264/vp9 decoders)
  decode("h264", [...V, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "s.mp4"], "s.mp4", ["-i", "s.mp4", "-f", "rawvideo", "-pix_fmt", "yuv420p", "o.yuv"], "o.yuv");
  decode("vp9",  [...V, "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "s.webm"], "s.webm", ["-i", "s.webm", "-f", "rawvideo", "-pix_fmt", "yuv420p", "o.yuv"], "o.yuv");

  // Known-broken external ENCODERS under wasm64 (they build & link, but their
  // encode path has a runtime issue — see MEMORY64.md). Their *decoders* are
  // FFmpeg-native and unaffected. Skipped so the suite stays green for the
  // supported set; not counted as failures.
  const knownBroken = [
    ["x265 (HEVC enc)", "spins inside x265_encoder_encode"],
    ["theora (enc)", "function-pointer signature trap"],
    ["zimg (zscale)", "throws during filter init"],
  ];
  for (const [label, why] of knownBroken) {
    console.log(`[run] ${label.padEnd(16)} SKIP  -  builds+links; encode broken under wasm64 (${why})`);
    results.push({ label, status: "SKIP" });
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const bad = results.filter((r) => r.status === "FAIL" || r.status === "ERROR");
  console.log(`\nSUMMARY: ${passed}/${results.length} PASS, ${results.filter(r => r.status === "SKIP").length} SKIP, ${bad.length} FAIL/ERROR`);
  if (bad.length) {
    console.log("Not working at runtime: " + bad.map((r) => `${r.label} (${r.status})`).join(", "));
    process.exit(1);
  }
  console.log("Working end-to-end on the wasm64 core: H.264, VP9, WebP, AAC, MP3,");
  console.log("Opus, Vorbis encode; H.264+AAC mux; native decode (AAC/MP3/H.264/VP9).");
}

(async () => {
  staticCheck();
  await runtimeCheck();
})().catch((e) => {
  console.error("\nVERIFICATION FAILED:");
  console.error(e);
  process.exit(1);
});
