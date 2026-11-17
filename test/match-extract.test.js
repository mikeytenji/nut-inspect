import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeToken, decodePaymentRequest, encodePaymentRequest } from "../src/index.js";
import { extractCashuStrings } from "../src/extract.js";
import { checkTokenAgainstRequest } from "../src/match.js";
import { V3_TOKEN, V4_TOKEN, CREQA_REQUEST, CREQB_REQUEST } from "./fixtures.js";

test("extracts real tokens from chat-like text and drops fakes", () => {
  const text = [
    "hey, payment for the stickers:",
    V4_TOKEN,
    "and an old one " + V3_TOKEN + " (thanks!)",
    "this one is fake: cashuBAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "invoice: " + CREQA_REQUEST,
    "qr version: " + CREQB_REQUEST,
    "duplicated on purpose: " + V4_TOKEN,
  ].join("\n");
  const found = extractCashuStrings(text);
  assert.equal(found.length, 4);
  assert.deepEqual(found.map((f) => f.kind), ["token", "token", "payment-request", "payment-request"]);
  assert.equal(found[0].decoded.entries[0].mint, "http://localhost:3338");
});

test("token satisfies a request it covers (amount + any mint)", () => {
  const token = decodeToken(V3_TOKEN); // 10 sat, mint 8333.space:3338
  const req = decodePaymentRequest(encodePaymentRequest({ amount: 10, unit: "sat" }));
  const report = checkTokenAgainstRequest(token, req);
  assert.equal(report.satisfies, true);
  assert.ok(report.checks.find((c) => c.name === "amount").status === "pass");
});

test("short amount fails with the exact shortfall", () => {
  const token = decodeToken(V4_TOKEN); // 4 sat
  const req = decodePaymentRequest(encodePaymentRequest({ amount: 10, unit: "sat" }));
  const report = checkTokenAgainstRequest(token, req);
  assert.equal(report.satisfies, false);
  assert.match(report.checks.find((c) => c.name === "amount").detail, /short of requested 10 by 6/);
});

test("strict mint list rejects a foreign mint; preference does not", () => {
  const token = decodeToken(V3_TOKEN);
  const strict = decodePaymentRequest(encodePaymentRequest({ amount: 1, unit: "sat", mints: ["https://other.example"], mintListStrict: true }));
  assert.equal(checkTokenAgainstRequest(token, strict).satisfies, false);
  const pref = decodePaymentRequest(encodePaymentRequest({ amount: 1, unit: "sat", mints: ["https://other.example"], mintListStrict: false }));
  const prefReport = checkTokenAgainstRequest(token, pref);
  assert.equal(prefReport.satisfies, true);
  assert.match(prefReport.checks.find((c) => c.name === "mint").detail, /non-preferred/);
});

test("plain token cannot pay a P2PK-locked request", () => {
  const token = decodeToken(V4_TOKEN);
  const req = decodePaymentRequest(encodePaymentRequest({
    amount: 1, unit: "sat",
    nut10: { kind: "P2PK", data: "02" + "ab".repeat(32), tags: [] },
  }));
  const report = checkTokenAgainstRequest(token, req);
  assert.equal(report.satisfies, false);
  assert.equal(report.checks.find((c) => c.name === "lock").status, "fail");
});

test("spent status is always reported unknown, never guessed", () => {
  const token = decodeToken(V4_TOKEN);
  const req = decodePaymentRequest(encodePaymentRequest({ amount: 1, unit: "sat" }));
  const report = checkTokenAgainstRequest(token, req);
  assert.equal(report.checks.find((c) => c.name === "spent-status").status, "unknown");
  assert.equal(report.certain, false);
});
