/**
 * Cashu payment requests — NUT-18 (creqA) and NUT-26 (creqB).
 *
 *   creqA: "creqA" + base64url(CBOR(PaymentRequest))
 *   creqB: Bech32m with HRP "creqb" over TLV(PaymentRequest)   (NUT-26)
 *
 * Both decode to the same normalized shape:
 *   {
 *     version: "A" | "B",
 *     id: string|null, amount: number|null, unit: string|null,
 *     singleUse: boolean|null, mints: string[], mintListStrict: boolean|null,
 *     description: string|null,
 *     transports: [{type, target, tags}],
 *     supportedMethods: [{method, fee}] | null,
 *     nut10: {kind, data, tags} | null,
 *     raw: object            // untouched decoded form, for forward-compat
 *   }
 */

import { base64UrlDecode, base64UrlEncode, bytesToHex, hexToBytes, utf8Decode, utf8Encode } from "./base64url.js";
import { decodeCbor, encodeCbor } from "./cbor.js";
import { bech32Decode, bech32Encode } from "./bech32.js";

export class PaymentRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "PaymentRequestError";
  }
}

export function isPaymentRequestString(input) {
  return typeof input === "string" && /^creq[AB]/i.test(input.trim());
}

/* ------------------------------- NUT-18 -------------------------------- */

function decodeCreqA(s) {
  let raw;
  try {
    raw = decodeCbor(base64UrlDecode(s.slice(5)));
  } catch (e) {
    throw new PaymentRequestError(`payment request is not valid base64url CBOR: ${e.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PaymentRequestError("payment request CBOR is not a map");
  }

  const transports = Array.isArray(raw.t)
    ? raw.t.map((t) => ({
        type: typeof t?.t === "string" ? t.t : "unknown",
        target: typeof t?.a === "string" ? t.a : "",
        tags: Array.isArray(t?.g) ? t.g : [],
      }))
    : [];

  const supportedMethods = Array.isArray(raw.sm)
    ? raw.sm.map((m) => ({ method: typeof m?.mn === "string" ? m.mn : "unknown", fee: m?.mf ?? 0 }))
    : null;

  let nut10 = null;
  if (raw.nut10 && typeof raw.nut10 === "object") {
    nut10 = {
      kind: typeof raw.nut10.k === "string" ? raw.nut10.k : "unknown",
      data: typeof raw.nut10.d === "string" ? raw.nut10.d : "",
      tags: Array.isArray(raw.nut10.t) ? raw.nut10.t : [],
    };
  }

  return {
    version: "A",
    id: typeof raw.i === "string" ? raw.i : null,
    amount: raw.a !== undefined ? Number(raw.a) : null,
    unit: typeof raw.u === "string" ? raw.u : null,
    singleUse: typeof raw.s === "boolean" ? raw.s : null,
    mints: Array.isArray(raw.m) ? raw.m.filter((x) => typeof x === "string") : [],
    // mp === true means the mint list is only a preference (advisory).
    mintListStrict: Array.isArray(raw.m) ? raw.mp !== true : null,
    description: typeof raw.d === "string" ? raw.d : null,
    transports,
    supportedMethods,
    nut10,
    raw,
  };
}

export function encodePaymentRequest(req) {
  const raw = {};
  if (req.id) raw.i = req.id;
  if (req.amount !== null && req.amount !== undefined) raw.a = req.amount;
  if (req.unit) raw.u = req.unit;
  if (req.singleUse !== null && req.singleUse !== undefined) raw.s = req.singleUse;
  if (Array.isArray(req.mints) && req.mints.length) {
    raw.m = req.mints;
    if (req.mintListStrict === false) raw.mp = true;
  }
  if (req.description) raw.d = req.description;
  if (Array.isArray(req.transports) && req.transports.length) {
    raw.t = req.transports.map((t) => {
      const out = { t: t.type, a: t.target };
      if (Array.isArray(t.tags) && t.tags.length) out.g = t.tags;
      return out;
    });
  }
  if (Array.isArray(req.supportedMethods) && req.supportedMethods.length) {
    raw.sm = req.supportedMethods.map((m) => {
      const out = { mn: m.method };
      if (m.fee) out.mf = m.fee;
      return out;
    });
  }
  if (req.nut10) {
    raw.nut10 = { k: req.nut10.kind, d: req.nut10.data };
    if (Array.isArray(req.nut10.tags) && req.nut10.tags.length) raw.nut10.t = req.nut10.tags;
  }
  return "creqA" + base64UrlEncode(encodeCbor(raw));
}

/* --------------------------- NIP-19 helpers ---------------------------- */
/* Only what NUT-26 transports need: npub / nprofile for nostr targets. */

function nip19Decode(str) {
  const { hrp, bytes } = bech32Decode(str);
  if (hrp === "npub") {
    if (bytes.length !== 32) throw new PaymentRequestError("npub does not contain a 32-byte public key");
    return { type: "npub", pubkey: bytes, relays: [] };
  }
  if (hrp === "nprofile") {
    let pubkey = null;
    const relays = [];
    let pos = 0;
    while (pos + 2 <= bytes.length) {
      const t = bytes[pos];
      const len = bytes[pos + 1];
      const value = bytes.slice(pos + 2, pos + 2 + len);
      if (value.length !== len) throw new PaymentRequestError("truncated nprofile TLV");
      if (t === 0) pubkey = value;
      else if (t === 1) relays.push(utf8Decode(value));
      pos += 2 + len;
    }
    if (!pubkey || pubkey.length !== 32) throw new PaymentRequestError("nprofile is missing its public key");
    return { type: "nprofile", pubkey, relays };
  }
  throw new PaymentRequestError(`unsupported NIP-19 type "${hrp}" in transport target`);
}

function nip19EncodeNpub(pubkey) {
  return bech32Encode("npub", pubkey, "bech32", false);
}

function nip19EncodeNprofile(pubkey, relays) {
  const parts = [Uint8Array.of(0, 32), pubkey];
  for (const relay of relays) {
    const rb = utf8Encode(relay);
    if (rb.length > 255) throw new PaymentRequestError("relay URL too long for nprofile");
    parts.push(Uint8Array.of(1, rb.length), rb);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return bech32Encode("nprofile", out, "bech32", false);
}

/* ------------------------------- NUT-26 -------------------------------- */

function tlvEntries(bytes) {
  const entries = [];
  let pos = 0;
  while (pos < bytes.length) {
    if (pos + 3 > bytes.length) throw new PaymentRequestError("truncated TLV entry header");
    const tag = bytes[pos];
    const len = (bytes[pos + 1] << 8) | bytes[pos + 2];
    const value = bytes.slice(pos + 3, pos + 3 + len);
    if (value.length !== len) throw new PaymentRequestError("truncated TLV entry value");
    entries.push({ tag, value });
    pos += 3 + len;
  }
  return entries;
}

function tlvBuild(entries) {
  const parts = [];
  for (const { tag, value } of entries) {
    if (value.length > 0xffff) throw new PaymentRequestError("TLV value too long");
    parts.push(Uint8Array.of(tag, (value.length >> 8) & 0xff, value.length & 0xff), value);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function u64be(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}
function readU64be(bytes) {
  if (bytes.length !== 8) throw new PaymentRequestError("u64 field is not 8 bytes");
  return Number(new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0));
}

/** Tag tuple encoding (NUT-26): keyLen|key, then (valueLen|value)* — length-delimited as a whole. */
function decodeTagTuple(bytes) {
  if (bytes.length < 1) throw new PaymentRequestError("empty tag tuple");
  const keyLen = bytes[0];
  const key = utf8Decode(bytes.slice(1, 1 + keyLen));
  const values = [];
  let pos = 1 + keyLen;
  while (pos < bytes.length) {
    const vLen = bytes[pos];
    values.push(utf8Decode(bytes.slice(pos + 1, pos + 1 + vLen)));
    pos += 1 + vLen;
  }
  return [key, ...values];
}
function encodeTagTuple(tuple) {
  const [key, ...values] = tuple;
  const kb = utf8Encode(key);
  if (kb.length > 255) throw new PaymentRequestError("tag key too long");
  const parts = [Uint8Array.of(kb.length), kb];
  for (const v of values) {
    const vb = utf8Encode(String(v));
    if (vb.length > 255) throw new PaymentRequestError("tag value too long");
    parts.push(Uint8Array.of(vb.length), vb);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const NUT10_KIND_BY_NUM = { 0: "P2PK", 1: "HTLC" };
const NUT10_NUM_BY_KIND = { P2PK: 0, HTLC: 1 };

function decodeTransportTlv(value) {
  let kind = null;
  let targetBytes = null;
  const tags = [];
  for (const e of tlvEntries(value)) {
    if (e.tag === 0x01) kind = e.value[0];
    else if (e.tag === 0x02) targetBytes = e.value;
    else if (e.tag === 0x03) tags.push(decodeTagTuple(e.value));
  }
  if (kind === 0) {
    // nostr: target is a raw 32-byte pubkey; "r" tuples are relays.
    if (!targetBytes || targetBytes.length !== 32) {
      throw new PaymentRequestError("nostr transport target is not a 32-byte public key");
    }
    const relays = [];
    const restTags = [];
    for (const t of tags) {
      if (t[0] === "r") relays.push(...t.slice(1));
      else restTags.push(t);
    }
    const target = relays.length ? nip19EncodeNprofile(targetBytes, relays) : nip19EncodeNpub(targetBytes);
    return { type: "nostr", target, tags: restTags };
  }
  if (kind === 1) {
    return { type: "post", target: targetBytes ? utf8Decode(targetBytes) : "", tags };
  }
  return { type: `unknown-${kind}`, target: targetBytes ? bytesToHex(targetBytes) : "", tags };
}

function encodeTransportTlv(transport) {
  const subs = [];
  if (transport.type === "nostr") {
    let pubkey;
    let relays = [];
    const tags = [...(transport.tags ?? [])];
    if (/^(npub|nprofile)1/.test(transport.target)) {
      const decoded = nip19Decode(transport.target);
      pubkey = decoded.pubkey;
      relays = decoded.relays;
    } else if (/^[0-9a-f]{64}$/i.test(transport.target)) {
      pubkey = hexToBytes(transport.target);
    } else {
      throw new PaymentRequestError(`cannot encode nostr transport target "${String(transport.target).slice(0, 30)}" — expected npub, nprofile, or 64-char hex pubkey`);
    }
    subs.push({ tag: 0x01, value: Uint8Array.of(0) });
    subs.push({ tag: 0x02, value: pubkey });
    if (relays.length) subs.push({ tag: 0x03, value: encodeTagTuple(["r", ...relays]) });
    for (const t of tags) subs.push({ tag: 0x03, value: encodeTagTuple(t) });
    return tlvBuild(subs);
  }
  if (transport.type === "post") {
    subs.push({ tag: 0x01, value: Uint8Array.of(1) });
    subs.push({ tag: 0x02, value: utf8Encode(transport.target) });
    for (const t of transport.tags ?? []) subs.push({ tag: 0x03, value: encodeTagTuple(t) });
    return tlvBuild(subs);
  }
  throw new PaymentRequestError(`cannot encode transport type "${transport.type}" as creqB`);
}

function decodeCreqB(s) {
  let decoded;
  try {
    decoded = bech32Decode(s, "creqb");
  } catch (e) {
    throw new PaymentRequestError(`creqB request is not valid Bech32m: ${e.message}`);
  }
  if (decoded.encoding !== "bech32m") {
    throw new PaymentRequestError("creqB request must use Bech32m, not Bech32");
  }
  const req = {
    version: "B",
    id: null, amount: null, unit: null, singleUse: null,
    mints: [], mintListStrict: null, description: null,
    transports: [], supportedMethods: null, nut10: null,
    raw: { tlvTags: [] },
  };
  let mintPreferred = null;
  const methods = [];
  for (const { tag, value } of tlvEntries(decoded.bytes)) {
    req.raw.tlvTags.push(tag);
    switch (tag) {
      case 0x01: req.id = utf8Decode(value); break;
      case 0x02: req.amount = readU64be(value); break;
      case 0x03:
        req.unit = value.length === 1 && value[0] === 0 ? "sat" : utf8Decode(value);
        break;
      case 0x04: req.singleUse = value[0] === 1; break;
      case 0x05: req.mints.push(utf8Decode(value)); break;
      case 0x06: req.description = utf8Decode(value); break;
      case 0x07: req.transports.push(decodeTransportTlv(value)); break;
      case 0x08: {
        let kind = "unknown";
        let data = "";
        const tags = [];
        for (const e of tlvEntries(value)) {
          if (e.tag === 0x01) kind = NUT10_KIND_BY_NUM[e.value[0]] ?? `kind_${e.value[0]}`;
          else if (e.tag === 0x02) data = utf8Decode(e.value);
          else if (e.tag === 0x03) tags.push(decodeTagTuple(e.value));
        }
        req.nut10 = { kind, data, tags };
        break;
      }
      case 0x09: mintPreferred = value[0] === 1; break;
      case 0x0a: {
        let method = "unknown";
        let fee = 0;
        for (const e of tlvEntries(value)) {
          if (e.tag === 0x01) method = utf8Decode(e.value);
          else if (e.tag === 0x02) fee = readU64be(e.value);
        }
        methods.push({ method, fee });
        break;
      }
      default: break; // unknown tags are ignored (forward compatibility)
    }
  }
  if (methods.length) req.supportedMethods = methods;
  if (req.mints.length) req.mintListStrict = mintPreferred !== true;
  return req;
}

export function encodePaymentRequestB(req) {
  const entries = [];
  if (req.id) entries.push({ tag: 0x01, value: utf8Encode(req.id) });
  if (req.amount !== null && req.amount !== undefined) entries.push({ tag: 0x02, value: u64be(req.amount) });
  if (req.unit) {
    entries.push({ tag: 0x03, value: req.unit === "sat" ? Uint8Array.of(0) : utf8Encode(req.unit) });
  }
  if (req.singleUse !== null && req.singleUse !== undefined) {
    entries.push({ tag: 0x04, value: Uint8Array.of(req.singleUse ? 1 : 0) });
  }
  for (const mint of req.mints ?? []) entries.push({ tag: 0x05, value: utf8Encode(mint) });
  if (req.description) entries.push({ tag: 0x06, value: utf8Encode(req.description) });
  for (const t of req.transports ?? []) entries.push({ tag: 0x07, value: encodeTransportTlv(t) });
  if (req.nut10) {
    const num = NUT10_NUM_BY_KIND[req.nut10.kind];
    if (num === undefined) throw new PaymentRequestError(`cannot encode unknown NUT-10 kind "${req.nut10.kind}" as creqB`);
    const subs = [
      { tag: 0x01, value: Uint8Array.of(num) },
      { tag: 0x02, value: utf8Encode(req.nut10.data) },
    ];
    for (const t of req.nut10.tags ?? []) subs.push({ tag: 0x03, value: encodeTagTuple(t) });
    entries.push({ tag: 0x08, value: tlvBuild(subs) });
  }
  if (Array.isArray(req.mints) && req.mints.length && req.mintListStrict === false) {
    entries.push({ tag: 0x09, value: Uint8Array.of(1) });
  }
  for (const m of req.supportedMethods ?? []) {
    const subs = [{ tag: 0x01, value: utf8Encode(m.method) }];
    if (m.fee) subs.push({ tag: 0x02, value: u64be(m.fee) });
    entries.push({ tag: 0x0a, value: tlvBuild(subs) });
  }
  // NUT-26: implementations SHOULD output uppercase for QR compatibility.
  return bech32Encode("creqb", tlvBuild(entries), "bech32m", true);
}

/* ------------------------------ public API ------------------------------ */

export function decodePaymentRequest(input) {
  if (typeof input !== "string") throw new PaymentRequestError("payment request must be a string");
  const s = input.trim().replace(/\s+/g, "");
  if (/^creqB/i.test(s)) return decodeCreqB(s);
  if (/^creqA/i.test(s)) return decodeCreqA(s);
  throw new PaymentRequestError("not a payment request: expected a string starting with creqA or creqB");
}
