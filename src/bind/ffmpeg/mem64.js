/**
 * Included as an extra `--pre-js` ONLY for the memory64 (wasm64) build.
 *
 * It flips `bind.js` into 64-bit pointer mode: BigInt addresses, 8-byte
 * pointer slots and BigInt `_malloc` arguments. Must be loaded before
 * bind.js so the flag is set when bind.js initialises its constants.
 */
Module["MEMORY64"] = 1;
