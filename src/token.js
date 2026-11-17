/**
 * Cashu token codec — NUT-00.
 *
 *   V3: cashuA + base64url(JSON)   (deprecated, multi-mint)
 *   V4: cashuB + base64url(CBOR)   (current, single-mint)
 *
 * Normalized shape used everywhere in this project:
 *
 *   {
 *     version: 3 | 4,
 *     unit: string | null,
 *     memo: string | null,
 *     entries: [
 *       { mint: string,
 *         proofs: [{ amount, id, secret, C, dleq?, witness? }] }
 *     ]
 *   }
 *
 * `dleq` is normalized to {e, s, r?} hex strings; `witness` stays a string.
 * Decoding is strict about structure but tolerant about base64 padding,
 * surrounding whitespace and the `cashu:` URI prefix, because real tokens
 * arrive pasted from chats and QR codes.
 */

import { base64UrlDecode, base64UrlEncode, bytesToHex, hexToBytes, utf8Decode, utf8Encode } from "./base64url.js";
import { decodeCbor, encodeCbor } from "./cbor.js";

export class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "TokenError";
  }
}

/** Strip whitespace and an optional `cashu:` URI prefix (possibly repeated). */
export function cleanTokenInput(input) {
  if (typeof input !== "string") throw new TokenError("token input must be a string");
  let s = input.trim().replace(/\s+/g, "");
  while (/^cashu:/i.test(s) && !/^cashu[AB]/i.test(s)) {
    s = s.slice("cashu:".length);
  }
  return s;
}

export function isTokenString(input) {
  if (typeof input !== "string") return false;
  try {
    const s = cleanTokenInput(input);
    return /^cashu[AB]/i.test(s);
  } catch {
    return false;
  }
}

function requireProofFields(p, where) {
  if (p === null || typeof p !== "object") throw new TokenError(`${where}: proof is not an object`);
  if (!Number.isInteger(p.amount) && typeof p.amount !== "bigint") {
    throw new TokenError(`${where}: proof amount is missing or not an integer`);
  }
  if (typeof p.secret !== "string" || p.secret.length === 0) {
    throw new TokenError(`${where}: proof secret is missing`);
  }
  if (typeof p.C !== "string" || p.C.length === 0) {
    throw new TokenError(`${where}: proof signature C is missing`);
  }
  if (typeof p.id !== "string" || p.id.length === 0) {
    throw new TokenError(`${where}: proof keyset id is missing`);
  }
}

function normalizeProof(p) {
  const out = {
    amount: typeof p.amount === "bigint" ? Number(p.amount) : p.amount,
    id: p.id,
    secret: p.secret,
    C: p.C,
  };
  if (p.dleq && typeof p.dleq === "object") {
    out.dleq = { e: p.dleq.e, s: p.dleq.s };
    if (p.dleq.r !== undefined) out.dleq.r = p.dleq.r;
  }
  if (typeof p.witness === "string") out.witness = p.witness;
  return out;
}

/* --------------------------------- V3 ---------------------------------- */

function decodeV3(payloadB64) {
  let jsonText;
  try {
    jsonText = utf8Decode(base64UrlDecode(payloadB64));
  } catch (e) {
    throw new TokenError(`V3 token is not valid base64url JSON: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    throw new TokenError("V3 token payload is not valid JSON");
  }
  if (!obj || !Array.isArray(obj.token)) {
    throw new TokenError("V3 token JSON is missing the \"token\" array");
  }
  const entries = obj.token.map((entry, ei) => {
    if (!entry || typeof entry.mint !== "string" || !Array.isArray(entry.proofs)) {
      throw new TokenError(`V3 token entry ${ei}: missing mint or proofs`);
    }
    entry.proofs.forEach((p, pi) => requireProofFields(p, `V3 entry ${ei} proof ${pi}`));
    return { mint: entry.mint.replace(/\/+$/, ""), proofs: entry.proofs.map(normalizeProof) };
  });
  return {
    version: 3,
    unit: typeof obj.unit === "string" ? obj.unit : null,
    memo: typeof obj.memo === "string" ? obj.memo : null,
    entries,
  };
}

function encodeV3(token) {
  const obj = {
    token: token.entries.map((e) => ({ mint: e.mint, proofs: e.proofs.map(normalizeProof) })),
  };
  if (token.unit) obj.unit = token.unit;
  if (token.memo) obj.memo = token.memo;
  return "cashuA" + base64UrlEncode(utf8Encode(JSON.stringify(obj)));
}

/* --------------------------------- V4 ---------------------------------- */

function bytesField(value, where) {
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (typeof value === "string") return value; // tolerate already-hex input
  throw new TokenError(`${where}: expected CBOR byte string`);
}

function decodeV4(payloadB64) {
  let raw;
  try {
    raw = decodeCbor(base64UrlDecode(payloadB64));
  } catch (e) {
    throw new TokenError(`V4 token is not valid base64url CBOR: ${e.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw instanceof Map) {
    throw new TokenError("V4 token CBOR is not a map");
  }
  if (typeof raw.m !== "string") throw new TokenError("V4 token is missing mint URL (\"m\")");
  if (!Array.isArray(raw.t)) throw new TokenError("V4 token is missing token entries (\"t\")");

  const proofs = [];
  raw.t.forEach((group, gi) => {
    if (!group || typeof group !== "object" || !Array.isArray(group.p)) {
      throw new TokenError(`V4 token group ${gi}: missing proofs ("p")`);
    }
    const id = bytesField(group.i, `V4 token group ${gi} keyset id ("i")`);
    for (const [pi, p] of group.p.entries()) {
      if (!p || typeof p !== "object") throw new TokenError(`V4 group ${gi} proof ${pi}: not an object`);
      const proof = {
        amount: typeof p.a === "bigint" ? Number(p.a) : p.a,
        id,
        secret: p.s,
        C: bytesField(p.c, `V4 group ${gi} proof ${pi} signature ("c")`),
      };
      if (p.d && typeof p.d === "object") {
        proof.dleq = { e: bytesField(p.d.e, "dleq e"), s: bytesField(p.d.s, "dleq s") };
        if (p.d.r !== undefined) proof.dleq.r = bytesField(p.d.r, "dleq r");
      }
      if (typeof p.w === "string") proof.witness = p.w;
      requireProofFields(proof, `V4 group ${gi} proof ${pi}`);
      proofs.push(proof);
    }
  });

  return {
    version: 4,
    unit: typeof raw.u === "string" ? raw.u : null,
    memo: typeof raw.d === "string" ? raw.d : null,
    entries: [{ mint: raw.m.replace(/\/+$/, ""), proofs }],
  };
}

function encodeV4(token) {
  if (token.entries.length !== 1) {
    throw new TokenError("V4 tokens can only hold proofs from a single mint — use V3 for multi-mint tokens");
  }
  const entry = token.entries[0];
  // Group proofs by keyset id, preserving first-seen order.
  const groups = new Map();
  for (const p of entry.proofs) {
    requireProofFields(p, "encode V4");
    if (!groups.has(p.id)) groups.set(p.id, []);
    groups.get(p.id).push(p);
  }
  const t = [...groups.entries()].map(([id, proofs]) => ({
    i: hexToBytes(id),
    p: proofs.map((p) => {
      const out = { a: p.amount, s: p.secret, c: hexToBytes(p.C) };
      if (p.dleq) {
        out.d = { e: hexToBytes(p.dleq.e), s: hexToBytes(p.dleq.s) };
        if (p.dleq.r !== undefined) out.d.r = hexToBytes(p.dleq.r);
      }
      if (typeof p.witness === "string") out.w = p.witness;
      return out;
    }),
  }));
  const obj = { m: entry.mint, u: token.unit ?? "sat", t };
  if (token.memo) obj.d = token.memo;
  return "cashuB" + base64UrlEncode(encodeCbor(obj));
}

/* ------------------------------ public API ------------------------------ */

export function decodeToken(input) {
  const s = cleanTokenInput(input);
  if (/^cashuA/i.test(s)) return decodeV3(s.slice(6));
  if (/^cashuB/i.test(s)) return decodeV4(s.slice(6));
  throw new TokenError("not a Cashu token: expected a string starting with cashuA (V3) or cashuB (V4)");
}

export function encodeToken(token, version = 4) {
  if (!token || !Array.isArray(token.entries) || token.entries.length === 0) {
    throw new TokenError("cannot encode: token has no entries");
  }
  if (version === 3) return encodeV3(token);
  if (version === 4) return encodeV4(token);
  throw new TokenError(`unknown token version ${version}`);
}

/** Total amount across all entries. Uses Number; amounts in Cashu are small ints. */
export function tokenTotal(token) {
  let total = 0;
  for (const e of token.entries) for (const p of e.proofs) total += p.amount;
  return total;
}

export function tokenProofCount(token) {
  return token.entries.reduce((n, e) => n + e.proofs.length, 0);
}
