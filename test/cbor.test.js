import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeCbor, encodeCbor } from "../src/cbor.js";
import { bytesToHex, hexToBytes } from "../src/base64url.js";

test("round-trips the shapes Cashu uses", () => {
  const value = {
    m: "https://mint.example",
    u: "sat",
    a: 9007199254740991, // max safe int stays exact
    neg: -42,
    t: [{ i: hexToBytes("00ffd48b8f5ecf80"), p: [{ a: 1, s: "abc", c: hexToBytes("02" + "11".repeat(32)) }] }],
    flag: true,
    other: false,
    nothing: null,
  };
  const decoded = decodeCbor(encodeCbor(value));
  assert.equal(decoded.m, value.m);
  assert.equal(decoded.a, value.a);
  assert.equal(decoded.neg, -42);
  assert.equal(bytesToHex(decoded.t[0].i), "00ffd48b8f5ecf80");
  assert.equal(decoded.t[0].p[0].s, "abc");
  assert.equal(decoded.flag, true);
  assert.equal(decoded.nothing, null);
});

test("decodes known CBOR bytes (RFC 8949 examples)", () => {
  assert.equal(decodeCbor(hexToBytes("00")), 0);
  assert.equal(decodeCbor(hexToBytes("182a")), 42);
  assert.equal(decodeCbor(hexToBytes("20")), -1);
  assert.equal(decodeCbor(hexToBytes("83010203")).join(","), "1,2,3");
  assert.equal(decodeCbor(hexToBytes("6449455446")), "IETF");
  assert.equal(decodeCbor(hexToBytes("f5")), true);
  assert.equal(decodeCbor(hexToBytes("f6")), null);
});

test("rejects truncated and trailing-garbage input", () => {
  assert.throws(() => decodeCbor(hexToBytes("8201")), /unexpected end/);
  assert.throws(() => decodeCbor(hexToBytes("0000")), /trailing/);
});

test("source of src/ contains no network APIs (offline guarantee)", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const files = await readdir(new URL("../src", import.meta.url));
  for (const f of files) {
    const src = await readFile(new URL(`../src/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:https?|from\s+["']https?["']/, `${f} must not use the network`);
  }
});
