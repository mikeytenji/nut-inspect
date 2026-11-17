/**
 * Inspection layer: turn a decoded token / payment request into a
 * human summary plus a list of hygiene warnings.
 *
 * Everything here is structural. We deliberately do NOT contact the mint
 * to ask whether proofs are spent — a Cashu token is a bearer instrument,
 * and phoning home with it would leak it. "Looks valid" here means
 * "well-formed", never "unspent". The report says so, every time.
 */

import { parseSecret, describeSecret } from "./secret.js";
import { tokenTotal, tokenProofCount } from "./token.js";

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/**
 * @param {object} token normalized token from decodeToken()
 * @returns inspection report (plain JSON-able object)
 */
export function inspectToken(token) {
  const warnings = [];
  const notes = [];

  if (token.version === 3) {
    warnings.push({
      level: "info",
      code: "v3-deprecated",
      message: "V3 token (cashuA). V3 is deprecated in NUT-00; most wallets still accept it, but ask senders for V4 (cashuB) when you can.",
    });
  }
  if (token.entries.length > 1) {
    notes.push(`Token carries proofs from ${token.entries.length} different mints.`);
  }
  if (!token.unit) {
    warnings.push({ level: "warn", code: "missing-unit", message: "Token has no unit field; wallets usually assume sat, but the sender should have set it." });
  }

  const seenSecrets = new Map();
  const seenSignatures = new Map();
  let proofIndex = 0;
  const perKeyset = new Map();
  const denominations = new Map();
  const conditions = [];

  for (const entry of token.entries) {
    for (const proof of entry.proofs) {
      proofIndex += 1;
      // duplicates
      if (seenSecrets.has(proof.secret)) {
        warnings.push({
          level: "warn",
          code: "duplicate-secret",
          message: `Duplicate proof secret (first seen as proof #${seenSecrets.get(proof.secret)}). The same proof appears twice — it can only be spent once.`,
        });
      } else {
        seenSecrets.set(proof.secret, proofIndex);
      }
      if (seenSignatures.has(proof.C)) {
        warnings.push({ level: "warn", code: "duplicate-signature", message: "Duplicate proof signature C — the same proof appears twice." });
      } else {
        seenSignatures.set(proof.C, true);
      }

      // amounts
      if (!Number.isInteger(proof.amount) || proof.amount <= 0) {
        warnings.push({ level: "error", code: "bad-amount", message: `Proof amount ${proof.amount} is not a positive integer.` });
      } else if (!isPowerOfTwo(proof.amount)) {
        notes.push(`Proof amount ${proof.amount} is not a power of two. That is unusual for Cashu denominations and worth a second look.`);
      }
      denominations.set(proof.amount, (denominations.get(proof.amount) ?? 0) + 1);

      // keysets
      const ks = perKeyset.get(proof.id) ?? { id: proof.id, count: 0, amount: 0, mint: entry.mint };
      ks.count += 1;
      ks.amount += proof.amount;
      perKeyset.set(proof.id, ks);
      if (/^[0-9a-f]{16}$/i.test(proof.id)) {
        // 8-byte form: could be a short keyset id (NUT-00) or a full legacy id.
        // We surface it once per keyset below instead of per proof.
      }

      // spending conditions
      const parsed = parseSecret(proof.secret);
      if (parsed.kind === "well-known") {
        conditions.push({
          condition: parsed.condition,
          nut: parsed.nut,
          label: parsed.label,
          data: parsed.data,
          summary: describeSecret(parsed),
          amount: proof.amount,
          keysetId: proof.id,
          mint: entry.mint,
        });
      }
      if (proof.dleq) notes.push("At least one proof carries a DLEQ proof (NUT-12) — a wallet can verify the mint signed it correctly, offline.");
      if (proof.witness) notes.push("At least one proof carries witness data (a spending condition was satisfied when it was created).");
    }
  }

  if (token.version === 4) {
    for (const ks of perKeyset.values()) {
      if (/^[0-9a-f]{16}$/i.test(ks.id)) {
        notes.push(`Keyset ${ks.id} uses the short (8-byte) ID form allowed by NUT-00 for V4 tokens; wallets resolve it to the full keyset ID at the mint.`);
      }
    }
  }

  if (conditions.length > 0) {
    warnings.push({
      level: "warn",
      code: "locked-proofs",
      message: `${conditions.length} proof(s) are locked by a spending condition (not anyone-can-spend). Only whoever satisfies the condition can redeem them — check the conditions list before accepting this token as payment.`,
    });
  }

  const manySmall = [...denominations.entries()].filter(([amt]) => amt === 1).reduce((n, [, c]) => n + c, 0);
  if (manySmall >= 100) {
    notes.push(`${manySmall} proofs of 1 ${token.unit ?? "sat"}: redeeming lots of tiny proofs costs the receiver input fees at swap/melt time (see NUT-02 / NUT-18 input fees).`);
  }

  // De-duplicate notes (dleq/witness can repeat per proof).
  const uniqueNotes = [...new Set(notes)];

  return {
    kind: "cashu-token",
    version: token.version,
    versionLabel: token.version === 3 ? "V3 (cashuA)" : "V4 (cashuB)",
    unit: token.unit,
    memo: token.memo,
    totalAmount: tokenTotal(token),
    proofCount: tokenProofCount(token),
    mints: token.entries.map((e) => e.mint),
    entries: token.entries.map((e) => ({
      mint: e.mint,
      proofCount: e.proofs.length,
      subtotal: e.proofs.reduce((s, p) => s + p.amount, 0),
    })),
    keysets: [...perKeyset.values()],
    denominations: [...denominations.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([amount, count]) => ({ amount, count })),
    conditions,
    warnings,
    notes: uniqueNotes,
    spentStatus: "not-checked (offline by design — only the mint knows, and asking it would mean revealing this token)",
  };
}

export function inspectPaymentRequest(req) {
  const warnings = [];
  const notes = [];
  if (req.amount === null) notes.push("No amount requested — the sender chooses how much to pay.");
  if (req.mints.length === 0) notes.push("No mint restriction — any mint is acceptable to this payee.");
  else if (req.mintListStrict) notes.push("Mint list is strict: pay only from the listed mint(s).");
  else notes.push("Mint list is a preference only; other mints are accepted.");
  if (req.singleUse) notes.push("Single-use request.");
  if (req.nut10) {
    warnings.push({
      level: "warn",
      code: "nut10-required",
      message: `Payee requires proofs locked with a ${req.nut10.kind} spending condition (NUT-10). A plain anyone-can-spend token does not satisfy this request.`,
    });
  }
  if (req.transports.length === 0) notes.push("No transport specified — payment is expected in-band (for example in an HTTP header).");
  return {
    kind: "cashu-payment-request",
    version: req.version,
    id: req.id,
    amount: req.amount,
    unit: req.unit,
    description: req.description,
    mints: req.mints,
    mintListStrict: req.mintListStrict,
    singleUse: req.singleUse,
    transports: req.transports,
    supportedMethods: req.supportedMethods,
    nut10: req.nut10,
    warnings,
    notes,
  };
}

/** Render an inspection report as plain text for humans / terminals. */
export function formatReport(report) {
  const lines = [];
  if (report.kind === "cashu-token") {
    lines.push(`Cashu token — ${report.versionLabel}`);
    lines.push(`Total: ${report.totalAmount} ${report.unit ?? "(unit not set)"} across ${report.proofCount} proof(s)`);
    if (report.memo) lines.push(`Memo: ${report.memo}`);
    for (const e of report.entries) lines.push(`Mint: ${e.mint} — ${e.subtotal} ${report.unit ?? ""} in ${e.proofCount} proof(s)`);
    lines.push(`Denominations: ${report.denominations.map((d) => `${d.amount}×${d.count}`).join(", ") || "none"}`);
    lines.push("Keysets:");
    for (const k of report.keysets) lines.push(`  ${k.id} — ${k.count} proof(s), ${k.amount} ${report.unit ?? ""}`);
    if (report.conditions.length) {
      lines.push("Spending conditions:");
      for (const c of report.conditions) lines.push(`  ${c.amount} ${report.unit ?? ""}: ${c.summary} [${c.nut ?? "unknown NUT"}]`);
    } else {
      lines.push("Spending conditions: none — plain anyone-can-spend proofs");
    }
    lines.push(`Spent status: ${report.spentStatus}`);
  } else {
    lines.push(`Cashu payment request — creq${report.version}`);
    lines.push(`Amount: ${report.amount === null ? "(any)" : `${report.amount} ${report.unit ?? ""}`}`);
    if (report.id) lines.push(`Payment id: ${report.id}`);
    if (report.description) lines.push(`Description: ${report.description}`);
    if (report.mints.length) lines.push(`Accepted mint(s): ${report.mints.join(", ")}${report.mintListStrict ? " (strict)" : " (preference only)"}`);
    for (const t of report.transports) lines.push(`Transport: ${t.type} → ${t.target}`);
    if (report.supportedMethods?.length) {
      lines.push(`Supported melt methods: ${report.supportedMethods.map((m) => (m.fee ? `${m.method} (+${m.fee} fee)` : m.method)).join(", ")}`);
    }
    if (report.nut10) lines.push(`Required lock: ${report.nut10.kind} (data: ${report.nut10.data})`);
  }
  for (const w of report.warnings) lines.push(`${w.level === "error" ? "✖" : "⚠"} ${w.message}`);
  for (const n of report.notes) lines.push(`• ${n}`);
  return lines.join("\n");
}
