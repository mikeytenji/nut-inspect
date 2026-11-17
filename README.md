# 🌰 nut-inspect

**See inside any Cashu token, offline.**

Someone pasted a `cashuB…` string into your chat, issue tracker, or support
ticket. How much is it? Which mint issued it? Is it locked to a public key,
or can anyone spend it? Is it even well-formed?

Your wallet can answer some of that — by *importing* the token and talking
to the mint. `nut-inspect` answers it by **just looking**: a zero-dependency
decoder, encoder, and structural inspector for Cashu tokens and payment
requests that runs in your terminal, in Node, or in a static web page —
and **never makes a network request**.

That last part is the point. A Cashu token is a bearer instrument: whoever
holds the string holds the money. Sending a token to an online "token
checker" to find out what it is would hand that service the money itself.
Inspection has to happen where the token already is. So this tool is built
to be run, read, and verified locally — the test suite even asserts that
`src/` contains no network APIs.

> Built for [Nut November 2026](https://nutnovember.org), the community
> hackathon for [Cashu](https://cashu.space), the Chaumian ecash protocol
> for Bitcoin. First-time Cashu contributor project. MIT licensed.

## What it does

- **Decodes V3 (`cashuA`) and V4 (`cashuB`) tokens** — NUT-00 — including
  multi-mint V3 tokens, short keyset IDs, DLEQ proofs (NUT-12), and witness
  data. Tolerates the mess real pastes arrive in: `cashu:` URI prefixes,
  whitespace/newlines, missing base64 padding.
- **Encodes tokens back** — decode → edit → re-encode, V3 ⇄ V4 conversion
  for single-mint tokens. Round-trips are covered by tests using the
  **official test vectors from the NUT-00 spec itself**.
- **Decodes payment requests — both encodings.** NUT-18 (`creqA`) and
  NUT-26 (`CREQB1…`, Bech32m + TLV): amount, accepted mints (and whether
  the list is strict or a preference), transports (nostr targets come
  back as readable npub/nprofile), supported melt methods and fees, and
  required NUT-10 locking conditions. Both formats also **encode** — the
  NUT-26 encoder reproduces the spec's own example string byte-for-byte,
  and the test suite proves it.
- **Answers "does this token pay this request?"** — pass a token and a
  payment request together and get a check-by-check verdict: unit,
  amount coverage (with the input-fee caveat stated, not hidden),
  strict-vs-preferred mint list, and whether the proofs carry the lock
  the request demands. Exit code 2 when it does not pay.
- **Scans text for the Cashu strings inside it** — `--scan chatlog.txt`
  finds and inspects every token/request pasted into a conversation or
  note. Candidates are validated by actually decoding them, so
  lookalike strings are dropped instead of reported.
- **Reads spending conditions out loud** — NUT-10 well-known secrets are
  parsed per proof: P2PK locks (NUT-11) with their pubkeys, signature
  counts, locktimes and refund keys; HTLC locks (NUT-14) with their hash
  locks — so "locked" stops being invisible until a redemption fails.
- **Flags hygiene problems**: duplicate proofs (the same proof twice can
  only be spent once), deprecated V3 format, missing unit, non-power-of-two
  denominations, locked proofs in a token offered as plain payment, and
  dust-proof sets that will cost the receiver input fees (NUT-02/NUT-18).
- **Tells you what it cannot know**: every report states that spent status
  is *not checked — offline by design*. "Well-formed" is never dressed up
  as "unspent".

## Quick start

Requires Node.js ≥ 18. No install step, no dependencies.

```sh
# Inspect a token (argument, file, or stdin — all work)
node bin/nut-inspect.js cashuBo2F0gqJhaUgA_9SLj17P…
node bin/nut-inspect.js --file examples/token-v4.txt
cat examples/payment-request.txt | node bin/nut-inspect.js

# Machine-readable output for scripts
node bin/nut-inspect.js --json --file examples/token-v3.txt

# Run the test suite (official NUT-00 / NUT-18 vectors included)
npm test

# Try the web demo (static page, same code, no server logic)
npm run demo   # → http://localhost:3737
```

Example output, for the V4 test vector published in NUT-00:

```
Cashu token — V4 (cashuB)
Total: 4 sat across 3 proof(s)
Mint: http://localhost:3338 — 4 sat in 3 proof(s)
Denominations: 1×2, 2×1
Keysets:
  00ffd48b8f5ecf80 — 1 proof(s), 1 sat
  00ad268c4d1f5826 — 2 proof(s), 3 sat
Spending conditions: none — plain anyone-can-spend proofs
Spent status: not-checked (offline by design — only the mint knows,
               and asking it would mean revealing this token)
```

Exit codes: `0` well-formed · `1` undecodable / bad usage ·
`2` decoded but contains an error-level warning.

## Library usage

```js
import { inspectString, decodeToken, encodeToken } from "./src/index.js";

// One call: detect, decode, inspect (token or payment request)
const report = inspectString(pastedString);

// Or work with the pieces
const token = decodeToken("cashuA…");       // normalized token object
const v4 = encodeToken(token, 4);           // re-encode as V4
```

The normalized token shape, the CBOR codec, and every other public
function are documented in the source headers under `src/`.

## How it works

| File | Responsibility |
|---|---|
| `src/cbor.js` | Minimal CBOR codec (RFC 8949) written for this project — Cashu's V4/CBOR formats need one, and pulling in a general library for six data types would break the zero-dependency rule. |
| `src/base64url.js` | base64url + hex helpers that accept padded and unpadded input, as NUT-00 requires. |
| `src/token.js` | NUT-00 token codec: V3 JSON and V4 CBOR ⇄ one normalized shape. |
| `src/paymentRequest.js` | NUT-18 `creqA` codec. |
| `src/secret.js` | NUT-10 well-known secret parser (P2PK / HTLC awareness). |
| `src/inspect.js` | Summaries, warnings, and the human-readable report. |
| `bin/nut-inspect.js` | CLI. |
| `demo/index.html` | Single static page importing the same `src/` modules. |

Amounts are handled as exact integers end-to-end in the CBOR layer
(BigInt where CBOR demands it); nothing is ever parsed through a float.

## Security notes

- **Bearer instrument warning.** Anyone who sees a complete token string
  can spend it. This tool never transmits tokens, but your shell history,
  screenshots, and terminal scrollback are storage too. The bundled
  examples are the public spec test vectors — not real money.
- **No mint contact, ever.** Checking whether proofs are spent requires
  the mint, and the mint learns which token you asked about. That check
  is deliberately out of scope.
- **Decoding is not verification.** This tool checks structure, not
  signatures. Verifying a mint's blind signature / DLEQ proof (NUT-12)
  against mint keys is real wallet work — see the roadmap.

## Roadmap

- Optional DLEQ verification (NUT-12) given a mint's published keys,
  still fully offline
- Optional, explicit `--check-spent` mode for users who *choose* to ask
  a mint — clearly separated from the default offline path

## What was built in November

Everything in this repository — codec, CBOR implementation, inspector,
CLI, demo, tests, and this README — was written from scratch between
1–27 November 2026 for Nut November. Nothing here predates November;
the only borrowed material is the official test vectors from the
NUT-00, NUT-18 and NUT-26 specifications, credited in `test/fixtures.js`.

## License

MIT — see [LICENSE](./LICENSE).
