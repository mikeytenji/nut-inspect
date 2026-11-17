#!/usr/bin/env node
/**
 * nut-inspect CLI — inspect a Cashu token or payment request, offline.
 *
 * Usage:
 *   nut-inspect <token-or-request>
 *   nut-inspect --json <token-or-request>
 *   echo <token> | nut-inspect
 *   nut-inspect --file token.txt
 *   nut-inspect --scan notes.txt        find every token/request in a text
 *   nut-inspect <token> <request>       check: does the token pay the request?
 *
 * Exit codes: 0 = well-formed / satisfied, 1 = could not decode / bad usage,
 *             2 = decoded but contains an error-level warning, or a
 *                 token that does not satisfy the given payment request.
 *
 * ⚠ A Cashu token is a bearer instrument: anyone who sees the full
 * string can spend it. This tool never transmits it anywhere, but
 * your shell history and terminal scrollback are yours to protect.
 */

import { readFileSync } from "node:fs";
import {
  inspectString, formatReport,
  decodeToken, decodePaymentRequest, isTokenString, isPaymentRequestString,
  extractCashuStrings, inspectToken, inspectPaymentRequest,
  checkTokenAgainstRequest, formatMatchReport,
} from "../src/index.js";

const VERSION = "1.1.0";

function usage() {
  return `nut-inspect ${VERSION} — see inside any Cashu token, offline.

Usage:
  nut-inspect [--json] <cashuA…|cashuB…|creqA…|CREQB…>
  nut-inspect [--json] --file <path>
  nut-inspect [--json] --scan <path>     find all tokens/requests inside a text file
  nut-inspect [--json] <token> <request> check whether the token pays the request
  cat token.txt | nut-inspect [--json]

Options:
  --json      print results as JSON
  --file <p>  read one token/request from a file instead of an argument
  --scan <p>  scan a text file and inspect everything Cashu-shaped inside it
  --help      show this help
  --version   show version

Works fully offline. It never contacts a mint, so it can tell you a
token is well-formed — never that it is unspent.`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function printReport(report, json) {
  if (json) console.log(JSON.stringify({ ok: true, report }, null, 2));
  else console.log(formatReport(report));
  return (report.warnings ?? []).some((w) => w.level === "error") ? 2 : 0;
}

async function main(argv) {
  const args = [...argv];
  let json = false;
  let file = null;
  let scan = null;
  const positional = [];

  while (args.length) {
    const a = args.shift();
    if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") { console.log(usage()); return 0; }
    else if (a === "--version" || a === "-v") { console.log(VERSION); return 0; }
    else if (a === "--file") {
      file = args.shift();
      if (!file) { console.error("nut-inspect: --file needs a path"); return 1; }
    } else if (a === "--scan") {
      scan = args.shift();
      if (!scan) { console.error("nut-inspect: --scan needs a path"); return 1; }
    } else positional.push(a);
  }

  // --scan mode: extract and inspect everything in a text file
  if (scan) {
    let text;
    try { text = readFileSync(scan, "utf8"); }
    catch (e) { console.error(`nut-inspect: cannot read ${scan}: ${e.message}`); return 1; }
    const found = extractCashuStrings(text);
    if (json) {
      console.log(JSON.stringify({
        ok: true,
        found: found.map((f) => ({
          kind: f.kind,
          report: f.kind === "token" ? inspectToken(f.decoded) : inspectPaymentRequest(f.decoded),
        })),
      }, null, 2));
    } else if (found.length === 0) {
      console.log("No Cashu tokens or payment requests found.");
    } else {
      console.log(`Found ${found.length} Cashu string(s):\n`);
      found.forEach((f, i) => {
        const report = f.kind === "token" ? inspectToken(f.decoded) : inspectPaymentRequest(f.decoded);
        console.log(`--- #${i + 1} (${f.kind}) ---`);
        console.log(formatReport(report));
        console.log("");
      });
    }
    return 0;
  }

  // match mode: exactly one token + one payment request
  if (positional.length === 2) {
    const [a, b] = positional;
    const tokenStr = isTokenString(a) ? a : isTokenString(b) ? b : null;
    const reqStr = isPaymentRequestString(a) ? a : isPaymentRequestString(b) ? b : null;
    if (tokenStr && reqStr && tokenStr !== reqStr) {
      try {
        const report = checkTokenAgainstRequest(decodeToken(tokenStr), decodePaymentRequest(reqStr));
        if (json) console.log(JSON.stringify({ ok: true, report }, null, 2));
        else console.log(formatMatchReport(report));
        return report.satisfies ? 0 : 2;
      } catch (e) {
        console.error(`nut-inspect: ${e.message}`);
        return 1;
      }
    }
    console.error("nut-inspect: with two arguments, one must be a token and the other a payment request");
    return 1;
  }

  let input = positional.join(" ").trim();
  if (!input && file) {
    try { input = readFileSync(file, "utf8").trim(); }
    catch (e) { console.error(`nut-inspect: cannot read ${file}: ${e.message}`); return 1; }
  }
  if (!input && !process.stdin.isTTY) input = (await readStdin()).trim();
  if (!input) {
    console.error(usage());
    return 1;
  }

  let report;
  try {
    report = inspectString(input);
  } catch (e) {
    if (json) console.log(JSON.stringify({ ok: false, error: e.message }, null, 2));
    else console.error(`nut-inspect: ${e.message}`);
    return 1;
  }
  return printReport(report, json);
}

process.exitCode = await main(process.argv.slice(2));
