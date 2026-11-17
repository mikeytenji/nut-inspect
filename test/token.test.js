import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeToken, encodeToken, tokenTotal, tokenProofCount } from "../src/token.js";
import { V3_TOKEN, V4_TOKEN } from "./fixtures.js";

test("decodes the official NUT-00 V3 vector", () => {
  const token = decodeToken(V3_TOKEN);
  assert.equal(token.version, 3);
  assert.equal(token.unit, "sat");
  assert.equal(token.memo, "Thank you.");
  assert.equal(token.entries.length, 1);
  assert.equal(token.entries[0].mint, "https://8333.space:3338");
  assert.equal(tokenProofCount(token), 2);
  assert.equal(tokenTotal(token), 10);
  assert.deepEqual(token.entries[0].proofs.map((p) => p.amount), [2, 8]);
  assert.equal(token.entries[0].proofs[0].id, "009a1f293253e41e");
});

test("decodes the official NUT-00 V4 vector", () => {
  const token = decodeToken(V4_TOKEN);
  assert.equal(token.version, 4);
  assert.equal(token.unit, "sat");
  assert.equal(token.memo, null);
  assert.equal(token.entries.length, 1);
  assert.equal(token.entries[0].mint, "http://localhost:3338");
  assert.equal(tokenProofCount(token), 3);
  assert.equal(tokenTotal(token), 4);
  const ids = new Set(token.entries[0].proofs.map((p) => p.id));
  assert.deepEqual([...ids].sort(), ["00ad268c4d1f5826", "00ffd48b8f5ecf80"]);
  // CBOR byte strings must come back as the spec's hex strings.
  assert.equal(
    token.entries[0].proofs[0].C,
    "0244538319de485d55bed3b29a642bee5879375ab9e7a620e11e48ba482421f3cf"
  );
  assert.equal(
    token.entries[0].proofs[0].secret,
    "acc12435e7b8484c3cf1850149218af90f716a52bf4a5ed347e48ecc13f77388"
  );
});

test("V3 round-trips through encode", () => {
  const decoded = decodeToken(V3_TOKEN);
  const again = decodeToken(encodeToken(decoded, 3));
  assert.deepEqual(again, decoded);
});

test("V4 round-trips through encode and re-encoding is stable in content", () => {
  const decoded = decodeToken(V4_TOKEN);
  const encoded = encodeToken(decoded, 4);
  assert.ok(encoded.startsWith("cashuB"));
  assert.deepEqual(decodeToken(encoded), decoded);
});

test("V3 can be converted to V4 for a single-mint token", () => {
  const v3 = decodeToken(V3_TOKEN);
  const v4 = decodeToken(encodeToken(v3, 4));
  assert.equal(v4.version, 4);
  assert.equal(tokenTotal(v4), 10);
  assert.equal(v4.memo, "Thank you.");
});

test("accepts cashu: URI prefix, whitespace and missing base64 padding", () => {
  const messy = "  cashu:" + V3_TOKEN + "\n";
  assert.equal(tokenTotal(decodeToken(messy)), 10);
  const unpadded = V4_TOKEN; // official vector is already unpadded
  assert.equal(tokenTotal(decodeToken(unpadded)), 4);
});

test("rejects garbage with a clear error", () => {
  assert.throws(() => decodeToken("hello world"), /not a Cashu token/);
  assert.throws(() => decodeToken("cashuA!!!not-base64!!!"), /V3 token/);
  assert.throws(() => decodeToken("cashuBAAAA"), /V4 token/);
  assert.throws(() => decodeToken(42), /must be a string/);
});

test("V4 encode rejects multi-mint tokens", () => {
  const multi = {
    version: 3,
    unit: "sat",
    memo: null,
    entries: [
      { mint: "https://a.example", proofs: [{ amount: 1, id: "00aa", secret: "s1", C: "02" + "11".repeat(32) }] },
      { mint: "https://b.example", proofs: [{ amount: 1, id: "00bb", secret: "s2", C: "02" + "22".repeat(32) }] },
    ],
  };
  assert.throws(() => encodeToken(multi, 4), /single mint/);
  assert.ok(encodeToken(multi, 3).startsWith("cashuA"));
});
