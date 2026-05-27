/**
 * Constants
 */

const NULL = 0;
const SIZE_I32 = Uint32Array.BYTES_PER_ELEMENT;
const DEFAULT_ARGS = ["./ffmpeg", "-nostdin", "-y"];
const DEFAULT_ARGS_FFPROBE = ["./ffprobe"];

/**
 * Memory64 (wasm64) support.
 *
 * In a MEMORY64 build wasm pointers are 64-bit, but Emscripten still hands them
 * to/from JS as plain Numbers (it converts at the wasm boundary, and addresses
 * comfortably fit in 2^53). So the ONLY thing that changes for this binding is
 * the in-memory pointer WIDTH: a pointer slot is 8 bytes instead of 4, and it
 * must be read/written with the pointer-typed accessor ("*") rather than "i32".
 *
 * `Module["MEMORY64"]` is set to a truthy value by the memory64 build via an
 * extra `--pre-js` (see src/bind/ffmpeg/mem64.js). In the default wasm32 build
 * it is undefined and `SIZE_PTR` is 4, so behaviour is unchanged.
 *
 * One wrinkle: Emscripten presents pointers from *library* functions (e.g.
 * `_malloc`) as Numbers, but the user-exported `_ffmpeg`/`_ffprobe` are raw wasm
 * exports whose `char **argv` is a 64-bit (i64) parameter — those must be passed
 * a real BigInt under memory64. `argvPtr` does that one conversion.
 */
const MEM64 = !!Module["MEMORY64"];
const SIZE_PTR = MEM64 ? 8 : SIZE_I32;
const argvPtr = (ptr) => (MEM64 ? BigInt(ptr) : ptr);

Module["NULL"] = NULL;
Module["SIZE_I32"] = SIZE_I32;
Module["DEFAULT_ARGS"] = DEFAULT_ARGS;
Module["DEFAULT_ARGS_FFPROBE"] = DEFAULT_ARGS_FFPROBE;

/**
 * Variables
 */

Module["ret"] = -1;
Module["timeout"] = -1;
Module["logger"] = () => {};
Module["progress"] = () => {};

/**
 * Functions
 */

function stringToPtr(str) {
  const len = Module["lengthBytesUTF8"](str) + 1;
  const ptr = Module["_malloc"](len);
  Module["stringToUTF8"](str, ptr, len);

  return ptr;
}

function stringsToPtr(strs) {
  const len = strs.length;
  const ptr = Module["_malloc"](len * SIZE_PTR);
  for (let i = 0; i < len; i++) {
    Module["setValue"](ptr + SIZE_PTR * i, stringToPtr(strs[i]), "*");
  }

  return ptr;
}

function print(message) {
  Module["logger"]({ type: "stdout", message });
}

function printErr(message) {
  if (!message.startsWith("Aborted(native code called abort())"))
    Module["logger"]({ type: "stderr", message });
}

function exec(..._args) {
  const args = [...Module["DEFAULT_ARGS"], ..._args];
  try {
    Module["_ffmpeg"](args.length, argvPtr(stringsToPtr(args)));
  } catch (e) {
    if (!e.message.startsWith("Aborted")) {
      throw e;
    }
  }
  return Module["ret"];
}

function ffprobe(..._args) {
  const args = [...Module["DEFAULT_ARGS_FFPROBE"], ..._args];
  try {
    Module["_ffprobe"](args.length, argvPtr(stringsToPtr(args)));
  } catch (e) {
    if (!e.message.startsWith("Aborted")) {
      throw e;
    }
  }
  return Module["ret"];
}

function setLogger(logger) {
  Module["logger"] = logger;
}

function setTimeout(timeout) {
  Module["timeout"] = timeout;
}

function setProgress(handler) {
  Module["progress"] = handler;
}

function receiveProgress(progress, time) {
  Module["progress"]({ progress, time });
}

function reset() {
  Module["ret"] = -1;
  Module["timeout"] = -1;
}

/**
 * In multithread version of ffmpeg.wasm, the bootstrap process is like:
 * 1. Execute ffmpeg-core.js
 * 2. ffmpeg-core.js spawns workers by calling `new Worker("ffmpeg-core.worker.js")`
 * 3. ffmpeg-core.worker.js imports ffmpeg-core.js
 * 4. ffmpeg-core.js imports ffmpeg-core.wasm
 *
 * It is a straightforward process when all files are in the same location.
 * But when files are in different location (or Blob URL), #4 fails because
 * there is no way to pass custom ffmpeg-core.wasm URL to ffmpeg-core.worker.js
 * when it imports ffmpeg-core.js in #3.
 *
 * To fix this issue, a hack here is leveraging mainScriptUrlOrBlob variable by
 * adding wasmURL and workerURL in base64 format as query string. ex:
 *
 *   http://example.com/ffmpeg-core.js#{btoa(JSON.stringify({"wasmURL": "...", "workerURL": "..."}))}
 *
 * Thus, we can successfully extract custom URLs using _locateFile funciton.
 */
function _locateFile(path, prefix) {
  const mainScriptUrlOrBlob = Module["mainScriptUrlOrBlob"];
  if (mainScriptUrlOrBlob) {
    const { wasmURL, workerURL } = JSON.parse(
      atob(mainScriptUrlOrBlob.slice(mainScriptUrlOrBlob.lastIndexOf("#") + 1))
    );
    if (path.endsWith(".wasm")) return wasmURL;
    if (path.endsWith(".worker.js")) return workerURL;
  }
  return prefix + path;
}

Module["stringToPtr"] = stringToPtr;
Module["stringsToPtr"] = stringsToPtr;
Module["print"] = print;
Module["printErr"] = printErr;
Module["locateFile"] = _locateFile;

Module["exec"] = exec;
Module["ffprobe"] = ffprobe;
Module["setLogger"] = setLogger;
Module["setTimeout"] = setTimeout;
Module["setProgress"] = setProgress;
Module["reset"] = reset;
Module["receiveProgress"] = receiveProgress;
