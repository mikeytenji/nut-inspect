/**
 * Bech32 / Bech32m (BIP-173 / BIP-350) — needed for NUT-26 payment
 * requests (HRP "creqb", Bech32m) and for Nostr identities inside
 * transports (HRP "npub" / "nprofile", classic Bech32, NIP-19).
 * Small, dependency-free implementation.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const LOOKUP = new Map([...CHARSET].map((c, i) => [c, i]));

export class Bech32Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Bech32Error";
  }
}

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

const ENCODINGS = { bech32: 1, bech32m: 0x2bc830a3 };

/** Decode a bech32/bech32m string. Returns {hrp, words, encoding, bytes}. */
export function bech32Decode(str, expectedHrp = null) {
  if (typeof str !== "string") throw new Bech32Error("bech32 input must be a string");
  const s = str.trim();
  if (s.length < 8 || s.length > 4096) throw new Bech32Error("bech32 string has an invalid length");
  const lower = s.toLowerCase();
  if (s !== lower && s !== s.toUpperCase()) throw new Bech32Error("bech32 string mixes upper and lower case");
  const pos = lower.lastIndexOf("1");
  if (pos < 1) throw new Bech32Error("bech32 string is missing the '1' separator");
  const hrp = lower.slice(0, pos);
  if (expectedHrp && hrp !== expectedHrp) throw new Bech32Error(`expected HRP "${expectedHrp}", got "${hrp}"`);
  const dataPart = lower.slice(pos + 1);
  if (dataPart.length < 6) throw new Bech32Error("bech32 data part is too short");
  const words = [];
  for (const c of dataPart) {
    const v = LOOKUP.get(c);
    if (v === undefined) throw new Bech32Error(`invalid bech32 character "${c}"`);
    words.push(v);
  }
  const check = polymod([...hrpExpand(hrp), ...words]);
  let encoding = null;
  if (check === ENCODINGS.bech32) encoding = "bech32";
  else if (check === ENCODINGS.bech32m) encoding = "bech32m";
  else throw new Bech32Error("bech32 checksum mismatch");
  const payloadWords = words.slice(0, -6);
  return { hrp, words: payloadWords, encoding, bytes: convertBits(payloadWords, 5, 8, false) };
}

/** Encode bytes as bech32/bech32m. Output is lowercase unless uppercase=true. */
export function bech32Encode(hrp, bytes, encoding = "bech32m", uppercase = false) {
  const words = convertBits([...bytes], 8, 5, true);
  const constVal = ENCODINGS[encoding];
  if (constVal === undefined) throw new Bech32Error(`unknown encoding ${encoding}`);
  const mod = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ constVal;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
  const out = hrp + "1" + [...words, ...checksum].map((w) => CHARSET[w]).join("");
  return uppercase ? out.toUpperCase() : out;
}

export function convertBits(data, fromBits, toBits, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >> fromBits !== 0) throw new Bech32Error("convertBits: value out of range");
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else {
    if (bits >= fromBits) throw new Bech32Error("convertBits: excess padding");
    if ((acc << (toBits - bits)) & maxv) throw new Bech32Error("convertBits: non-zero padding");
  }
  return Uint8Array.from(out);
}
