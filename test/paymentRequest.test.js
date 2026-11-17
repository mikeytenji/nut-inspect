import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePaymentRequest, encodePaymentRequest, encodePaymentRequestB } from "../src/paymentRequest.js";
import { inspectPaymentRequest } from "../src/inspect.js";
import { CREQA_REQUEST, CREQB_REQUEST } from "./fixtures.js";

test("decodes the official NUT-18 vector", () => {
  const req = decodePaymentRequest(CREQA_REQUEST);
  assert.equal(req.id, "b7a90176");
  assert.equal(req.amount, 10);
  assert.equal(req.unit, "sat");
  assert.deepEqual(req.mints, ["https://nofees.testnut.cashu.space"]);
  assert.equal(req.mintListStrict, true);
  assert.equal(req.transports.length, 1);
  assert.equal(req.transports[0].type, "nostr");
  assert.ok(req.transports[0].target.startsWith("nprofile1"));
  assert.deepEqual(req.transports[0].tags, [["n", "17"]]);
});

test("payment request round-trips", () => {
  const req = decodePaymentRequest(CREQA_REQUEST);
  const again = decodePaymentRequest(encodePaymentRequest(req));
  assert.equal(again.id, req.id);
  assert.equal(again.amount, req.amount);
  assert.equal(again.unit, req.unit);
  assert.deepEqual(again.mints, req.mints);
  assert.deepEqual(again.transports, req.transports);
});

test("can build a fresh request from scratch", () => {
  const encoded = encodePaymentRequest({
    id: "deadbeef",
    amount: 21,
    unit: "sat",
    mints: ["https://mint.example"],
    mintListStrict: true,
    description: "coffee",
    transports: [{ type: "post", target: "https://shop.example/pay", tags: [] }],
  });
  assert.ok(encoded.startsWith("creqA"));
  const req = decodePaymentRequest(encoded);
  assert.equal(req.amount, 21);
  assert.equal(req.description, "coffee");
  assert.equal(req.transports[0].type, "post");
});

test("decodes the official NUT-26 creqB vector", () => {
  const req = decodePaymentRequest(CREQB_REQUEST);
  assert.equal(req.version, "B");
  assert.equal(req.id, "demo123");
  assert.equal(req.amount, 1000);
  assert.equal(req.unit, "sat");
  assert.equal(req.singleUse, true);
  assert.deepEqual(req.mints, ["https://mint.example.com"]);
  assert.equal(req.mintListStrict, true);
  assert.equal(req.description, "Coffee payment");
});

test("creqB round-trips and encodes uppercase per NUT-26", () => {
  const req = decodePaymentRequest(CREQB_REQUEST);
  const encoded = encodePaymentRequestB(req);
  assert.ok(encoded.startsWith("CREQB1"));
  assert.equal(encoded, encoded.toUpperCase());
  const again = decodePaymentRequest(encoded);
  assert.equal(again.id, "demo123");
  assert.equal(again.amount, 1000);
  assert.equal(again.unit, "sat");
  assert.equal(again.singleUse, true);
  assert.deepEqual(again.mints, req.mints);
  assert.equal(again.description, "Coffee payment");
});

test("creqB with a post transport and a P2PK lock round-trips", () => {
  const encoded = encodePaymentRequestB({
    amount: 42,
    unit: "sat",
    transports: [{ type: "post", target: "https://shop.example/pay", tags: [] }],
    nut10: { kind: "P2PK", data: "02" + "ab".repeat(32), tags: [["sigflag", "SIG_INPUTS"]] },
  });
  const req = decodePaymentRequest(encoded);
  assert.equal(req.amount, 42);
  assert.equal(req.transports[0].type, "post");
  assert.equal(req.transports[0].target, "https://shop.example/pay");
  assert.equal(req.nut10.kind, "P2PK");
  assert.deepEqual(req.nut10.tags, [["sigflag", "SIG_INPUTS"]]);
});

test("creqB with a nostr transport exposes an npub target", () => {
  const pubkeyHex = "82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2";
  const encoded = encodePaymentRequestB({
    amount: 7,
    unit: "sat",
    transports: [{ type: "nostr", target: pubkeyHex, tags: [["n", "17"]] }],
  });
  const req = decodePaymentRequest(encoded);
  assert.equal(req.transports[0].type, "nostr");
  assert.ok(req.transports[0].target.startsWith("npub1"));
  assert.deepEqual(req.transports[0].tags, [["n", "17"]]);
});

test("bad creqB checksum is rejected", () => {
  assert.throws(() => decodePaymentRequest(CREQB_REQUEST.slice(0, -2) + "qq"), /Bech32m|checksum/);
});

test("inspecting a request with a required lock warns", () => {
  const encoded = encodePaymentRequest({
    amount: 5,
    unit: "sat",
    nut10: { kind: "P2PK", data: "02" + "ab".repeat(32), tags: [] },
  });
  const report = inspectPaymentRequest(decodePaymentRequest(encoded));
  assert.ok(report.warnings.some((w) => w.code === "nut10-required"));
});
