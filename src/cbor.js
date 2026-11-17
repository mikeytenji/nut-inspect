/**
 * Minimal CBOR (RFC 8949) codec — just enough for Cashu.
 *
 * Cashu V4 tokens (NUT-00) and payment requests (NUT-18) are CBOR maps
 * with text keys, unsigned ints, byte strings, text strings, arrays,
 * booleans and null. This module implements definite-length encoding
 * for those types, plus decoding of indefinite-length containers and
 * simple/float values so foreign encoders do not break us.
 *
 * Decoded byte strings are returned as Uint8Array. Maps are returned
 * as plain JS objects when all keys are strings, otherwise as Map.
 * No dependencies. No network. No eval.
 */

export class CborError extends Error {
  constructor(message) {
    super(message);
    this.name = "CborError";
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  need(n) {
    if (this.pos + n > this.bytes.length) throw new CborError("CBOR: unexpected end of input");
  }
  u8() {
    this.need(1);
    return this.bytes[this.pos++];
  }
  take(n) {
    this.need(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  uint(n) {
    this.need(n);
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(this.bytes[this.pos++]);
    return v;
  }
}

function readArgument(reader, ai) {
  if (ai < 24) return BigInt(ai);
  if (ai === 24) return BigInt(reader.u8());
  if (ai === 25) return reader.uint(2);
  if (ai === 26) return reader.uint(4);
  if (ai === 27) return reader.uint(8);
  if (ai === 31) return null; // indefinite marker
  throw new CborError(`CBOR: reserved additional information ${ai}`);
}

function bigToSafeNumber(v, what) {
  if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return v; // keep BigInt for very large values instead of losing precision
}

export function decodeCbor(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const reader = new Reader(bytes);
  const value = readItem(reader);
  if (reader.pos !== bytes.length) {
    throw new CborError(`CBOR: ${bytes.length - reader.pos} trailing byte(s) after first item`);
  }
  return value;
}

function readItem(reader) {
  const ib = reader.u8();
  const major = ib >> 5;
  const ai = ib & 0x1f;

  switch (major) {
    case 0: {
      const v = readArgument(reader, ai);
      if (v === null) throw new CborError("CBOR: indefinite length not allowed for uint");
      return bigToSafeNumber(v, "uint");
    }
    case 1: {
      const v = readArgument(reader, ai);
      if (v === null) throw new CborError("CBOR: indefinite length not allowed for negative int");
      const n = -1n - v;
      return bigToSafeNumber(n, "int");
    }
    case 2: {
      const len = readArgument(reader, ai);
      if (len === null) {
        // indefinite byte string: concatenated definite chunks
        const chunks = [];
        let total = 0;
        for (;;) {
          const headPos = reader.pos;
          const head = reader.u8();
          if (head === 0xff) break;
          if (head >> 5 !== 2) throw new CborError("CBOR: bad chunk in indefinite byte string");
          reader.pos = headPos;
          const chunk = readItem(reader);
          if (!(chunk instanceof Uint8Array)) throw new CborError("CBOR: bad chunk type");
          chunks.push(chunk);
          total += chunk.length;
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
      }
      return reader.take(Number(len));
    }
    case 3: {
      const len = readArgument(reader, ai);
      if (len === null) {
        let out = "";
        for (;;) {
          const headPos = reader.pos;
          const head = reader.u8();
          if (head === 0xff) break;
          if (head >> 5 !== 3) throw new CborError("CBOR: bad chunk in indefinite text string");
          reader.pos = headPos;
          out += readItem(reader);
        }
        return out;
      }
      const raw = reader.take(Number(len));
      try {
        return textDecoder.decode(raw);
      } catch {
        throw new CborError("CBOR: invalid UTF-8 in text string");
      }
    }
    case 4: {
      const len = readArgument(reader, ai);
      const arr = [];
      if (len === null) {
        for (;;) {
          const headPos = reader.pos;
          if (reader.u8() === 0xff) break;
          reader.pos = headPos;
          arr.push(readItem(reader));
        }
        return arr;
      }
      for (let i = 0; i < Number(len); i++) arr.push(readItem(reader));
      return arr;
    }
    case 5: {
      const len = readArgument(reader, ai);
      const entries = [];
      let allStringKeys = true;
      const readPair = () => {
        const k = readItem(reader);
        const v = readItem(reader);
        if (typeof k !== "string") allStringKeys = false;
        entries.push([k, v]);
      };
      if (len === null) {
        for (;;) {
          const headPos = reader.pos;
          if (reader.u8() === 0xff) break;
          reader.pos = headPos;
          readPair();
        }
      } else {
        for (let i = 0; i < Number(len); i++) readPair();
      }
      if (allStringKeys) {
        const obj = {};
        for (const [k, v] of entries) obj[k] = v;
        return obj;
      }
      return new Map(entries);
    }
    case 6: {
      // Tag: ignore the tag, return the tagged item (Cashu does not use tags).
      readArgument(reader, ai);
      return readItem(reader);
    }
    case 7: {
      if (ai < 20) return ai; // unassigned simple values, returned as-is
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      if (ai === 25) {
        // half float — we already consumed ai bits; value is in the argument bytes.
        // readArgument is not used here because ai==25 for major 7 means 2-byte float.
        const bits = Number(reader.uint(2));
        return decodeHalf(bits);
      }
      if (ai === 26) {
        const buf = reader.take(4);
        return new DataView(buf.buffer, buf.byteOffset, 4).getFloat32(0);
      }
      if (ai === 27) {
        const buf = reader.take(8);
        return new DataView(buf.buffer, buf.byteOffset, 8).getFloat64(0);
      }
      if (ai === 24) return reader.u8();
      if (ai === 31) throw new CborError("CBOR: unexpected break");
      throw new CborError(`CBOR: unsupported simple value ai=${ai}`);
    }
    default:
      throw new CborError(`CBOR: bad major type ${major}`);
  }
}

function decodeHalf(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  if (exp === 0) return sign * (frac / 1024) * 2 ** -14;
  if (exp === 31) return frac === 0 ? sign * Infinity : NaN;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/* ------------------------------- encoding ------------------------------- */

class Writer {
  constructor() { this.chunks = []; }
  push(bytes) { this.chunks.push(bytes); }
  byte(b) { this.chunks.push(Uint8Array.of(b)); }
  result() {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) { out.set(c, off); off += c.length; }
    return out;
  }
}

function writeTypeAndLength(writer, major, length) {
  const mt = major << 5;
  const len = typeof length === "bigint" ? length : BigInt(length);
  if (len < 24n) {
    writer.byte(mt | Number(len));
  } else if (len < 256n) {
    writer.byte(mt | 24);
    writer.byte(Number(len));
  } else if (len < 65536n) {
    writer.byte(mt | 25);
    writer.push(Uint8Array.of(Number(len >> 8n) & 0xff, Number(len) & 0xff));
  } else if (len < 4294967296n) {
    writer.byte(mt | 26);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, Number(len));
    writer.push(b);
  } else {
    writer.byte(mt | 27);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, len);
    writer.push(b);
  }
}

function writeItem(writer, value) {
  if (value === null) { writer.byte(0xf6); return; }
  if (value === undefined) { writer.byte(0xf7); return; }
  if (value === true) { writer.byte(0xf5); return; }
  if (value === false) { writer.byte(0xf4); return; }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CborError("CBOR: cannot encode non-finite number as int; floats are not used by Cashu");
    if (!Number.isInteger(value)) {
      // Encode as float64 — not used by Cashu, but kept for completeness.
      writer.byte(0xfb);
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, value);
      writer.push(b);
      return;
    }
    value = BigInt(value);
  }
  if (typeof value === "bigint") {
    if (value >= 0n) {
      writeTypeAndLength(writer, 0, value);
    } else {
      writeTypeAndLength(writer, 1, -1n - value);
    }
    return;
  }
  if (typeof value === "string") {
    const bytes = textEncoder.encode(value);
    writeTypeAndLength(writer, 3, bytes.length);
    writer.push(bytes);
    return;
  }
  if (value instanceof Uint8Array) {
    writeTypeAndLength(writer, 2, value.length);
    writer.push(value);
    return;
  }
  if (Array.isArray(value)) {
    writeTypeAndLength(writer, 4, value.length);
    for (const item of value) writeItem(writer, item);
    return;
  }
  if (value instanceof Map) {
    writeTypeAndLength(writer, 5, value.size);
    for (const [k, v] of value) { writeItem(writer, k); writeItem(writer, v); }
    return;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    writeTypeAndLength(writer, 5, keys.length);
    for (const k of keys) { writeItem(writer, k); writeItem(writer, value[k]); }
    return;
  }
  throw new CborError(`CBOR: cannot encode value of type ${typeof value}`);
}

export function encodeCbor(value) {
  const writer = new Writer();
  writeItem(writer, value);
  return writer.result();
}
