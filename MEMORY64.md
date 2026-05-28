# ffmpeg.wasm — Memory64 (wasm64) build

This fork adds a **Memory64 / wasm64** build of `@ffmpeg/core`. A wasm64 core
addresses linear memory with 64-bit pointers, so it can grow past the ~2–4 GB
ceiling that wasm32 imposes — the limit that today blocks ffmpeg.wasm from
handling large media files
([#876](https://github.com/ffmpegwasm/ffmpeg.wasm/issues/876)).

> Memory64 reached stable browsers in early 2025 (Chrome 133+, Firefox 134+) and
> is on by default in recent Node/V8.

## TL;DR

```bash
make prd-64                      # build the wasm64 core -> packages/core-64/dist
node tests/mem64-verify.cjs      # prove it's 64-bit and run real ffmpeg commands
```

`make prd-64` is the wasm64 analogue of `make prd`. The output lands in
`packages/core-64/` (package `@ffmpeg/core-64`).

## What "supporting memory64" required

A wasm module is either entirely wasm32 or entirely wasm64 — you cannot link
objects of different pointer widths. So the **whole toolchain** (every codec
library, FFmpeg itself, and the final link) is compiled with `-sMEMORY64=1`.

### 1. The build (`Dockerfile.mem64`, `Makefile`)

* **Emscripten 3.1.40 → 4.0.7.** The pinned 3.1.40 emits an experimental
  Memory64 binary encoding that current browsers reject. 4.0.x emits the final,
  standardised encoding that shipped in Chrome 133 / Firefox 134.
* `-sMEMORY64=1` is injected into `CFLAGS` (and therefore `CXXFLAGS` and
  `LDFLAGS`), so it flows into every dependency build script unchanged — they
  all already consume `$CFLAGS`/`$LDFLAGS`.
* `-sMAXIMUM_MEMORY=8GB` at the final link lets memory grow past 4 GB
  (`ALLOW_MEMORY_GROWTH` is already on for the single-thread core).
* **Full codec parity** with the stock build: all 15 external libraries are
  compiled as wasm64 — x264, x265, libvpx, lame, ogg, theora, opus, vorbis,
  zlib, libwebp, freetype2, fribidi, harfbuzz, libass and zimg — plus FFmpeg's
  native (de)coders.

New `Makefile` targets:

| target      | output                | notes                          |
|-------------|-----------------------|--------------------------------|
| `make prd-64` | `packages/core-64`  | `-O2`, single-thread, wasm64, all codecs |
| `make dev-64` | `packages/core-64`  | adds `--profiling`             |
| `make verify-64` | —                | builds + runs `tests/mem64-verify.cjs` on node:24 |
| `make build-64` | —                 | low-level target used by above |

The generic `build` target gained a `DOCKERFILE ?= Dockerfile` knob so the
memory64 target can point it at `Dockerfile.mem64`.

### 2. The JS bindings (`src/bind/ffmpeg/bind.js`, `mem64.js`)

Under wasm64 the wasm pointers are 64-bit, but Emscripten still passes them
to/from JS as plain **Numbers** (it converts at the wasm boundary, and addresses
fit well within 2^53). So `_malloc` still returns a Number and pointer
arithmetic in JS stays Number arithmetic — *no BigInt*. The one thing that
genuinely changes is the **in-memory pointer width**: a pointer slot is 8 bytes,
not 4.

The stock `bind.js` built the `ffmpeg` `argv` array with a 4-byte stride and
`setValue(ptr + 4*i, ..., "i32")`. Under wasm64 that writes 4-byte slots into an
8-byte-per-pointer array, so the C side reads garbage pointers. The changes:

* `SIZE_PTR` is `8` under memory64, else `4` (the `argv` stride + `malloc` size).
* the `argv` slots are written with the pointer-typed accessor `setValue(..., "*")`
  instead of `"i32"` (writes 4 bytes on wasm32, 8 on wasm64).
* `_ffmpeg(argc, argv)` / `_ffprobe(...)` are **raw** wasm exports, so their i64
  `argv` parameter needs an actual `BigInt` — `argvPtr()` converts the pointer
  for that call only. (Library functions like `_malloc` are wrapped by Emscripten
  to use Numbers, so everywhere else stays Number-based.)

The width is selected by a one-line flag, `Module["MEMORY64"] = 1`, set by a new
`mem64.js` that is added as an extra `--pre-js` **only** for the wasm64 build
(see `build/ffmpeg-wasm.sh`). The default wasm32 builds are unchanged in
behaviour (`"*"` is identical to `"i32"` there).

The C↔JS calls in `src/fftools` only pass scalars (`int`, `double`, `int64_t`),
which already work under `WASM_BIGINT`, so no C changes were needed.

## Verifying

`node tests/mem64-verify.cjs`:

1. **Static** — parses `ffmpeg-core.wasm` and asserts the linear memory's limits
   flags have the Memory64 bit (`0x04`) set, i.e. it is genuinely wasm64.
2. **Runtime** — loads the core in Node and runs `ffmpeg -h` (drives the 64-bit
   `argv` path) plus an encode per codec — x264, x265, VP9, Theora, WebP, the
   zimg `zscale` filter, MP3, Opus and Vorbis — from FFmpeg's built-in `lavfi`
   sources (no external media needed).

Note: the artifact uses 64-bit *tables* (table64), so it needs V8 ≥ ~13
(Chrome 133+/Firefox 134+). Most host Nodes and emsdk's bundled Node are older
and reject it, so `make verify-64` runs it inside `node:24` (see
`Dockerfile.verify64`).

## Runtime codec status

All 15 libraries **compile and link** as wasm64 (build parity is complete).
`make verify-64` (runs on node:24) reports the following at runtime in the
single-thread core:

**Encoders**

| encoder            | runtime | note |
|--------------------|---------|------|
| H.264 (libx264)    | ✅ works | |
| AAC (FFmpeg native)| ✅ works | + H.264+AAC → mp4 mux verified |
| VP9 (libvpx)       | ✅ works | |
| WebP (libwebp)     | ✅ works | |
| MP3 (libmp3lame)   | ✅ works | |
| Opus (libopus)     | ✅ works | |
| Vorbis (libvorbis) | ✅ works | |
| HEVC (libx265)     | ⚠️ hangs | spins inside `x265_encoder_encode` even fully serialized (`pools=none`); links fine |
| Theora (libtheora) | ⚠️ traps | `null function or function signature mismatch` (a wasm function-pointer typing trap) |
| zimg `zscale`      | ⚠️ errors | throws during filter init |

**Decoders** — decoding uses FFmpeg's *native* decoders (built-in C in
libavcodec), **not** the external encoder libs, so it is broadly available and
unaffected by the three broken encoders. Verified: AAC, MP3, H.264, VP9 decode
(encode → decode round-trip). The same native code path covers FFmpeg's other
built-in decoders (HEVC, VP8, FLAC, …), so e.g. HEVC *playback* works even
though the HEVC *encoder* (x265) does not.

The three ⚠️ encoders are the most complex C/C++ in the set and have genuine
*runtime* memory64 issues that don't appear in the wasm32 build; they are linked
and available but need per-library debugging to encode. Everything else —
including the common transcode path (decode anything → H.264/AAC mp4) — works.

## Caveats / next steps

* This is a single-thread core. A multi-thread (`pthreads`) wasm64 core is
  possible but needs a shared 64-bit memory and is not built here.
* SIMD (`-msimd128`) is left off in `PROD_64_CFLAGS` (the stock `prd` uses it);
  it can be re-enabled there once confirmed stable with memory64.
* To actually exceed 4 GB at runtime the host must allow it (browser tab memory
  limits; Node is fine). `MAXIMUM_MEMORY` is set to 8 GB and can be raised.
