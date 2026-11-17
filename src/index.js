/**
 * nut-inspect — see inside any Cashu token, offline.
 *
 * Public library entry point. Everything exported here is pure and
 * offline: decoding, encoding and structural inspection of Cashu
 * tokens (NUT-00) and payment requests (NUT-18), including NUT-10
 * spending-condition parsing. No network, no mint calls, ever.
 */

export { decodeCbor, encodeCbor, CborError } from "./cbor.js";
export { base64UrlDecode, base64UrlEncode, bytesToHex, hexToBytes } from "./base64url.js";
export {
  decodeToken,
  encodeToken,
  isTokenString,
  cleanTokenInput,
  tokenTotal,
  tokenProofCount,
  TokenError,
} from "./token.js";
export {
  decodePaymentRequest,
  encodePaymentRequest,
  encodePaymentRequestB,
  isPaymentRequestString,
  PaymentRequestError,
} from "./paymentRequest.js";
export { bech32Decode, bech32Encode, Bech32Error } from "./bech32.js";
export { parseSecret, describeSecret } from "./secret.js";
export { inspectToken, inspectPaymentRequest, formatReport } from "./inspect.js";
export { extractCashuStrings } from "./extract.js";
export { checkTokenAgainstRequest, formatMatchReport } from "./match.js";

/**
 * One-call helper: accept a pasted string, work out what it is,
 * decode it and return an inspection report.
 */
import { decodeToken, isTokenString } from "./token.js";
import { decodePaymentRequest, isPaymentRequestString } from "./paymentRequest.js";
import { inspectToken, inspectPaymentRequest } from "./inspect.js";

export function inspectString(input) {
  if (isPaymentRequestString(input)) {
    return inspectPaymentRequest(decodePaymentRequest(input));
  }
  if (isTokenString(input)) {
    return inspectToken(decodeToken(input));
  }
  throw new Error("unrecognized input: expected a Cashu token (cashuA… / cashuB…) or a payment request (creqA…)");
}
