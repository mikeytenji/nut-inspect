/**
 * base64url helpers (RFC 4648 §5) that accept padded and unpadded input,
 * as required by NUT-00: "Clients need to be able to decode both cases."
 * Works in Node.js and browsers — no Buffer dependency.
 */

export class Base64Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Base64Error";
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base64UrlEncode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (i + 1 < bytes.length) out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (i + 2 < bytes.length) out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64UrlDecode(str) {
  if (typeof str !== "string") throw new Base64Error("base64url input must be a string");
  const clean = str.replace(/=+$/, "").replace(/\s+/g, "");
  if (/[^A-Za-z0-9\-_]/.test(clean)) {
    throw new Base64Error("invalid character in base64url input");
  }
  if (clean.length % 4 === 1) throw new Base64Error("invalid base64url length");
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    acc = (acc << 6) | LOOKUP.get(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid hex string: ${String(hex).slice(0, 40)}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function utf8Encode(str) { return utf8Encoder.encode(str); }
export function utf8Decode(bytes) { return utf8Decoder.decode(bytes); }
