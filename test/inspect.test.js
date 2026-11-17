import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeToken, encodeToken } from "../src/token.js";
import { inspectToken, inspectString, formatReport } from "../src/index.js";
import { parseSecret } from "../src/secret.js";
import { V3_TOKEN, V4_TOKEN, CREQA_REQUEST } from "./fixtures.js";

test("inspect V3 vector: totals, keysets, denominations, deprecation note", () => {
  const report = inspectToken(decodeToken(V3_TOKEN));
  assert.equal(report.totalAmount, 10);
  assert.equal(report.proofCount, 2);
  assert.deepEqual(report.denominations, [
    { amount: 2, count: 1 },
    { amount: 8, count: 1 },
  ]);
  assert.equal(report.keysets.length, 1);
  assert.ok(report.warnings.some((w) => w.code === "v3-deprecated"));
  assert.equal(report.conditions.length, 0);
  assert.match(report.spentStatus, /not-checked/);
  const text = formatReport(report);
  assert.match(text, /Total: 10 sat/);
  assert.match(text, /8333\.space/);
});

test("inspect V4 vector: two keysets, no lock warnings", () => {
  const report = inspectToken(decodeToken(V4_TOKEN));
  assert.equal(report.totalAmount, 4);
  assert.equal(report.keysets.length, 2);
  assert.equal(report.warnings.filter((w) => w.level !== "info").length, 0);
});

test("duplicate proofs are flagged", () => {
  const token = decodeToken(V3_TOKEN);
  token.entries[0].proofs.push({ ...token.entries[0].proofs[0] });
  const report = inspectToken(token);
  assert.ok(report.warnings.some((w) => w.code === "duplicate-secret"));
  assert.ok(report.warnings.some((w) => w.code === "duplicate-signature"));
});

test("P2PK-locked proof is parsed and flagged (NUT-10 / NUT-11)", () => {
  const secret = JSON.stringify([
    "P2PK",
    {
      nonce: "0f3d2a1b",
      data: "02" + "ab".repeat(32),
      tags: [["sigflag", "SIG_INPUTS"], ["n_sigs", "1"]],
    },
  ]);
  const parsed = parseSecret(secret);
  assert.equal(parsed.kind, "well-known");
  assert.equal(parsed.condition, "P2PK");
  assert.equal(parsed.nut, "NUT-11");
  assert.equal(parsed.tagMap.sigflag[0], "SIG_INPUTS");

  const token = {
    version: 4,
    unit: "sat",
    memo: null,
    entries: [
      {
        mint: "https://mint.example",
        proofs: [{ amount: 64, id: "009a1f293253e41e", secret, C: "02" + "cd".repeat(32) }],
      },
    ],
  };
  // full pipeline: encode -> decode -> inspect
  const report = inspectToken(decodeToken(encodeToken(token, 4)));
  assert.equal(report.conditions.length, 1);
  assert.equal(report.conditions[0].condition, "P2PK");
  assert.ok(report.warnings.some((w) => w.code === "locked-proofs"));
});

test("HTLC secret with locktime and refund is described (NUT-14)", () => {
  const secret = JSON.stringify([
    "HTLC",
    {
      nonce: "aa",
      data: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      tags: [["locktime", "1893456000"], ["refund", "02" + "ef".repeat(32)]],
    },
  ]);
  const parsed = parseSecret(secret);
  assert.equal(parsed.condition, "HTLC");
  assert.equal(parsed.nut, "NUT-14");
  assert.equal(parsed.tagMap.locktime[0], "1893456000");
});

test("plain hex secret is not mistaken for a spending condition", () => {
  assert.equal(parseSecret("407915bc212be61a77e3e6d2aeb4c727980bda51cd06a6afc29e2861768a7837").kind, "plain");
  assert.equal(parseSecret("[not json").kind, "plain");
});

test("inspectString dispatches tokens and payment requests", () => {
  assert.equal(inspectString(V4_TOKEN).kind, "cashu-token");
  assert.equal(inspectString(CREQA_REQUEST).kind, "cashu-payment-request");
  assert.throws(() => inspectString("lnbc1example"), /unrecognized input/);
});
