// Focused probe: is libx265 hung (encoder init) or just slow (encode loop)?
const fs = require("fs");
const path = require("path");
const PKG = path.join(__dirname, "..", "packages", "core-64");
const UMD_DIR = path.join(PKG, "dist", "umd");
const WASM = path.join(UMD_DIR, "ffmpeg-core.wasm");
if (typeof globalThis.self === "undefined") globalThis.self = globalThis;
if (typeof globalThis.location === "undefined")
  globalThis.location = { href: "file://" + UMD_DIR + "/ffmpeg-core.js" };

(async () => {
  const createFFmpegCore = require(PKG);
  const core = await createFFmpegCore({ wasmBinary: fs.readFileSync(WASM) });
  // stream ffmpeg's own logs so we can see how far x265 gets
  core.setLogger(({ message }) => { if (message) console.log("  | " + message); });
  core.setProgress(() => {});

  // Abort the transcode loop after 12s. If x265 is merely slow (stuck in the
  // per-frame loop), this returns 1. If it's hung in encoder init (before the
  // loop), the timeout won't fire and the OS timeout around `docker run` kills us.
  core.setTimeout(12000);

  console.log(">>> calling x265 encode now (watch for log lines / timeout)...");
  const t0 = Date.now();
  const ret = core.exec(
    "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=2",
    "-c:v", "libx265", "-preset", "ultrafast",
    "-x265-params", "pools=none:frame-threads=1:wpp=0:log-level=full",
    "-pix_fmt", "yuv420p", "out.mkv"
  );
  console.log(`<<< x265 exec returned ret=${ret} after ${((Date.now()-t0)/1000).toFixed(1)}s`);
})().catch((e) => { console.error("THREW:", e.message); process.exit(1); });
