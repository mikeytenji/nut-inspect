/**
 * NUT-10 well-known secrets: spending conditions hidden inside Proof.secret.
 *
 * A plain proof has a random secret (usually 64 hex chars). A locked proof
 * has a secret that is a JSON string of the form:
 *
 *   ["P2PK", {"nonce": "...", "data": "<pubkey>", "tags": [["sigflag","SIG_INPUTS"], ...]}]
 *   ["HTLC", {"nonce": "...", "data": "<sha256 hashlock>", "tags": [["preimage","..."], ...]}]
 *
 * This module only *parses* the condition so a human can see it.
 * It never tries to satisfy it, and it never signs anything.
 */

const KNOWN_KINDS = {
  P2PK: {
    nut: "NUT-11",
    label: "Pay-to-Public-Key (P2PK)",
    dataMeaning: "compressed public key that must sign to spend",
  },
  HTLC: {
    nut: "NUT-14",
    label: "Hashed Timelock Contract (HTLC)",
    dataMeaning: "SHA-256 hash lock; spender must reveal the preimage",
  },
};

/**
 * Parse a proof secret.
 * @returns {{kind:'plain'} | {kind:'well-known', condition:string, nut:string|null,
 *   label:string, nonce:string, data:string, dataMeaning:string|null,
 *   tags:Array<string[]>, tagMap:Record<string,string[]>}}
 */
export function parseSecret(secret) {
  if (typeof secret !== "string") return { kind: "plain" };
  const trimmed = secret.trim();
  if (!trimmed.startsWith("[")) return { kind: "plain" };

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "plain" };
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return { kind: "plain" };
  const [condition, body] = parsed;
  if (typeof condition !== "string" || body === null || typeof body !== "object") {
    return { kind: "plain" };
  }
  if (typeof body.data !== "string") return { kind: "plain" };

  const tags = Array.isArray(body.tags) ? body.tags.filter(Array.isArray).map((t) => t.map(String)) : [];
  const tagMap = {};
  for (const tag of tags) {
    if (tag.length === 0) continue;
    const [name, ...values] = tag;
    tagMap[name] = values;
  }

  const known = KNOWN_KINDS[condition];
  return {
    kind: "well-known",
    condition,
    nut: known ? known.nut : null,
    label: known ? known.label : `Unknown spending condition "${condition}"`,
    nonce: typeof body.nonce === "string" ? body.nonce : "",
    data: body.data,
    dataMeaning: known ? known.dataMeaning : null,
    tags,
    tagMap,
  };
}

/** Convenience: human one-liner for a parsed secret. */
export function describeSecret(parsed) {
  if (!parsed || parsed.kind !== "well-known") return "plain (anyone who holds the token can spend it)";
  const parts = [`locked — ${parsed.label}`];
  if (parsed.tagMap.locktime?.[0]) {
    const ts = Number(parsed.tagMap.locktime[0]);
    if (Number.isFinite(ts) && ts > 0) {
      parts.push(`locktime ${new Date(ts * 1000).toISOString()}`);
    }
  }
  if (parsed.tagMap.n_sigs?.[0]) parts.push(`requires ${parsed.tagMap.n_sigs[0]} signature(s)`);
  if (parsed.tagMap.pubkeys?.length) parts.push(`+${parsed.tagMap.pubkeys.length} extra pubkey(s) in tags`);
  if (parsed.tagMap.refund?.length) parts.push("has refund key(s) after locktime");
  return parts.join(", ");
}
