/**
 * Matching: does this token satisfy this payment request?
 *
 * The question a payer actually asks before sending. Checked offline,
 * structurally, per NUT-18 semantics:
 *
 *  - unit must match when the request names one
 *  - token total must cover the requested amount (note: the receiver's
 *    input fees depend on the mint's keysets, which only the mint can
 *    state — so "covers the amount" is necessary, not sufficient;
 *    the report says exactly that)
 *  - when the request's mint list is strict, every proof must come
 *    from a listed mint; when it is a preference, other mints pass
 *    with a note
 *  - when the request requires a NUT-10 lock, the proofs must carry
 *    that lock (same kind, same data) — a plain token does not pay a
 *    locked request
 *  - single-use and spent status cannot be known offline: reported
 *    as "unknown", never guessed
 */

import { parseSecret } from "./secret.js";
import { tokenTotal } from "./token.js";

export function checkTokenAgainstRequest(token, request) {
  const checks = [];
  const total = tokenTotal(token);
  const unit = token.unit ?? request.unit ?? null;

  // unit
  if (request.unit && token.unit && request.unit !== token.unit) {
    checks.push({ name: "unit", status: "fail", detail: `request wants ${request.unit}, token is ${token.unit}` });
  } else if (request.unit) {
    checks.push({ name: "unit", status: "pass", detail: `unit ${request.unit}` });
  } else {
    checks.push({ name: "unit", status: "unknown", detail: "request names no unit" });
  }

  // amount
  if (request.amount === null || request.amount === undefined) {
    checks.push({ name: "amount", status: "unknown", detail: "request names no amount — any amount is acceptable to the payee" });
  } else if (total >= request.amount) {
    checks.push({
      name: "amount",
      status: "pass",
      detail: `token total ${total} ${unit ?? ""} covers requested ${request.amount} ${request.unit ?? ""} — before input fees: the receiver still pays swap/melt input fees (NUT-02), which only the mint's keyset data can price, so a small surplus is wise`.trim(),
    });
  } else {
    checks.push({ name: "amount", status: "fail", detail: `token total ${total} is short of requested ${request.amount} by ${request.amount - total}` });
  }

  // mints
  const tokenMints = [...new Set(token.entries.map((e) => e.mint.replace(/\/+$/, "")))];
  const accepted = (request.mints ?? []).map((m) => m.replace(/\/+$/, ""));
  if (accepted.length === 0) {
    checks.push({ name: "mint", status: "pass", detail: "request accepts any mint" });
  } else {
    const outside = tokenMints.filter((m) => !accepted.includes(m));
    if (outside.length === 0) {
      checks.push({ name: "mint", status: "pass", detail: `all proofs are from accepted mint(s): ${tokenMints.join(", ")}` });
    } else if (request.mintListStrict) {
      checks.push({ name: "mint", status: "fail", detail: `mint list is strict and token uses unlisted mint(s): ${outside.join(", ")}` });
    } else {
      checks.push({ name: "mint", status: "pass", detail: `token uses non-preferred mint(s) ${outside.join(", ")} — accepted, but the payee prefers: ${accepted.join(", ")}` });
    }
  }

  // NUT-10 lock requirement
  if (request.nut10) {
    const proofs = token.entries.flatMap((e) => e.proofs);
    const matching = proofs.filter((p) => {
      const parsed = parseSecret(p.secret);
      return parsed.kind === "well-known" && parsed.condition === request.nut10.kind && parsed.data === request.nut10.data;
    });
    if (matching.length === proofs.length && proofs.length > 0) {
      checks.push({ name: "lock", status: "pass", detail: `all ${proofs.length} proof(s) carry the required ${request.nut10.kind} lock` });
    } else if (matching.length === 0) {
      checks.push({ name: "lock", status: "fail", detail: `request requires proofs locked with ${request.nut10.kind} (data ${request.nut10.data}) — no proof in this token carries that lock` });
    } else {
      checks.push({ name: "lock", status: "fail", detail: `only ${matching.length} of ${proofs.length} proofs carry the required ${request.nut10.kind} lock — a payment payload must be locked as a whole` });
    }
  } else {
    checks.push({ name: "lock", status: "pass", detail: "request requires no spending-condition lock" });
  }

  checks.push({ name: "spent-status", status: "unknown", detail: "cannot be known offline — only the mint knows whether these proofs were already spent" });
  if (request.singleUse) {
    checks.push({ name: "single-use", status: "unknown", detail: "request is single-use; whether it was already paid cannot be known offline" });
  }

  const satisfies = checks.every((c) => c.status !== "fail");
  return {
    kind: "token-request-match",
    satisfies,
    certain: checks.every((c) => c.status !== "unknown"),
    totalAmount: total,
    requestedAmount: request.amount ?? null,
    unit,
    checks,
  };
}

export function formatMatchReport(report) {
  const lines = [];
  lines.push(`Token vs payment request: ${report.satisfies ? "SATISFIES every checkable requirement" : "does NOT satisfy the request"}`);
  if (report.satisfies && !report.certain) lines.push("(with unknowns listed below — offline checking cannot resolve them)");
  for (const c of report.checks) {
    const mark = c.status === "pass" ? "✓" : c.status === "fail" ? "✖" : "?";
    lines.push(`${mark} ${c.name}: ${c.detail}`);
  }
  return lines.join("\n");
}
