const fs = require('fs');
const path = require('path');

// WASM实例缓存
let wasmInstancePromise = null;

// 加载WASM文件
function loadWasmFile() {
  const wasmPath = path.join(__dirname, 'sha3_wasm_bg.7b9ca65ddd.wasm');
  if (fs.existsSync(wasmPath)) {
    const buffer = fs.readFileSync(wasmPath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  throw new Error(`WASM file not found: ${wasmPath}`);
}

// 加载并实例化WASM模块
async function loadPowWasm() {
  if (wasmInstancePromise) return wasmInstancePromise;
  
  wasmInstancePromise = (async () => {
    const wasmBuf = loadWasmFile();
    const { instance } = await WebAssembly.instantiate(wasmBuf, {});
    const e = instance.exports;
    
    if (!e || !e.memory || !e.__wbindgen_add_to_stack_pointer || !e.__wbindgen_export_0 || !e.wasm_solve) {
      throw new Error("Missing expected WASM exports");
    }
    
    return instance;
  })();
  
  return wasmInstancePromise;
}

// 辅助函数
function u8(mem) {
  return new Uint8Array(mem.buffer);
}

function writeBytes(mem, ptr, bytes) {
  u8(mem).set(bytes, ptr);
}

function readI32(mem, ptr) {
  return new DataView(mem.buffer).getInt32(ptr, true);
}

function readF64(mem, ptr) {
  return new DataView(mem.buffer).getFloat64(ptr, true);
}

// 使用WASM计算POW答案
async function computePowAnswerWasm(ch) {
  if (ch.algorithm !== "DeepSeekHashV1") {
    throw new Error("Unsupported algorithm");
  }
  
  const e = (await loadPowWasm()).exports;
  const mem = e.memory;
  
  // 构造prefix: salt_expire_at_
  const prefix = `${ch.salt}_${ch.expire_at}_`;
  const enc = new TextEncoder();
  
  const chBytes = enc.encode(String(ch.challenge));
  const preBytes = enc.encode(prefix);
  
  const chPtr = Number(e.__wbindgen_export_0(chBytes.length, 1));
  writeBytes(mem, chPtr, chBytes);
  
  const prePtr = Number(e.__wbindgen_export_0(preBytes.length, 1));
  writeBytes(mem, prePtr, preBytes);
  
  const retptr = Number(e.__wbindgen_add_to_stack_pointer(-16));
  e.wasm_solve(retptr, chPtr, chBytes.length, prePtr, preBytes.length, Number(ch.difficulty));
  
  const status = readI32(mem, retptr);
  const value = readF64(mem, retptr + 8);
  
  e.__wbindgen_add_to_stack_pointer(16);
  
  if (status === 0) return null;
  return Math.trunc(value);
}

// 获取POW响应
async function getPowResponse(challenge) {
  const normalized = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    difficulty: challenge.difficulty ?? 144000,
    expire_at: challenge.expire_at ?? 1680000000000,
    signature: challenge.signature,
    target_path: challenge.target_path
  };
  
  const answer = await computePowAnswerWasm(normalized);
  if (answer == null) return null;
  
  const powDict = {
    algorithm: normalized.algorithm,
    challenge: normalized.challenge,
    salt: normalized.salt,
    answer,
    signature: normalized.signature,
    target_path: normalized.target_path
  };
  
  return Buffer.from(JSON.stringify(powDict), "utf8").toString("base64");
}

module.exports = {
  loadPowWasm,
  computePowAnswerWasm,
  getPowResponse
};