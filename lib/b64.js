// b64.js —— Uint8Array ↔ base64（扩展消息是 JSON 序列化，二进制必须编码传输）
export function u8ToB64(u8) {
  let s = '';
  const B = 0x8000;
  for (let i = 0; i < u8.length; i += B) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + B));
  }
  return btoa(s);
}

export function b64ToU8(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
