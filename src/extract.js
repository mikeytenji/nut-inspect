/**
 * Extraction: find Cashu tokens and payment requests embedded in free
 * text — a chat log, an email, a support ticket, a Nostr note dump.
 *
 * Candidates are matched by prefix and charset, then *validated by
 * actually decoding them*. Anything that does not decode is dropped,
 * so random words starting with "cashu" do not produce false hits.
 */

import { decodeToken } from "./token.js";
import { decodePaymentRequest } from "./paymentRequest.js";

// cashuA/cashuB payloads are base64url; creqA is base64url too.
// creqB is bech32m (case-consistent, charset qpzry9x8gf2tvdw0s3jn54khce6mua7l).
const CANDIDATE_RE =
  /cashu[AB][A-Za-z0-9\-_]{16,}={0,2}|creqA[A-Za-z0-9\-_]{16,}={0,2}|CREQB1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{16,}|creqb1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{16,}/g;

/**
 * @returns {Array<{raw:string, kind:'token'|'payment-request', decoded:object}>}
 * Unique, in first-appearance order, only entries that really decode.
 */
export function extractCashuStrings(text) {
  if (typeof text !== "string") return [];
  const found = [];
  const seen = new Set();
  for (const match of text.matchAll(CANDIDATE_RE)) {
    let raw = match[0];
    // A token wrapped as cashu:cashuB… — the regex finds the inner part;
    // also strip a trailing sentence period that base64url never contains
    // (already guaranteed by the charset) — nothing else to clean.
    if (seen.has(raw)) continue;
    try {
      const decoded = decodeToken(raw);
      seen.add(raw);
      found.push({ raw, kind: "token", decoded });
      continue;
    } catch { /* not a token — try payment request */ }
    try {
      const decoded = decodePaymentRequest(raw);
      seen.add(raw);
      found.push({ raw, kind: "payment-request", decoded });
    } catch { /* false candidate — drop it */ }
  }
  return found;
}
