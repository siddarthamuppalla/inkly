#!/usr/bin/env node
// Summarizes a `wrangler tail --format json` capture for #72: every invocation whose
// outcome was not "ok", and every request that logged request_start but no request_end
// (workers/api/src/request-log.ts), with the step it stopped in and all its log lines. Usage: node scripts/tail-summary.mjs artifacts/tail.jsonl
import { readFileSync } from "node:fs";

/** Splits concatenated JSON values (one per line or pretty-printed) into objects. */
export function parseConcatenated(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // a truncated object at the end of the capture
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Every log line of an invocation, as "<ISO time> <level> <message>", plus its exceptions. */
function logText(event) {
  const lines = (event.logs ?? []).map((log) => {
    const at = log.timestamp ? new Date(log.timestamp).toISOString() : "?";
    const message = (log.message ?? [])
      .map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
      .join(" ");
    return `${at} ${log.level ?? "log"} ${message}`;
  });
  for (const x of event.exceptions ?? []) {
    const at = x.timestamp ? new Date(x.timestamp).toISOString() : "?";
    lines.push(`${at} exception ${x.name}: ${x.message}${x.stack ? `\n${x.stack}` : ""}`);
  }
  return lines;
}

/** The step_start lines (packages/domain/log `step`) with no step_end or step_error after them. */
function openSteps(event) {
  const open = [];
  for (const line of ourLines(event)) {
    if (line.event === "step_start") open.push(line.step);
    if (line.event === "step_end" || line.event === "step_error") {
      const i = open.lastIndexOf(line.step);
      if (i >= 0) open.splice(i, 1);
    }
  }
  return open;
}

function ourLines(event) {
  const lines = [];
  for (const log of event.logs ?? []) {
    for (const part of log.message ?? []) {
      if (typeof part !== "string" || !part.startsWith("{")) continue;
      try {
        lines.push(JSON.parse(part));
      } catch {
        // not one of ours
      }
    }
  }
  return lines;
}

function requestLines(event) {
  const lines = [];
  for (const log of event.logs ?? []) {
    for (const part of log.message ?? []) {
      if (typeof part !== "string" || !part.startsWith("{")) continue;
      try {
        const line = JSON.parse(part);
        if (line.event === "request_start" || line.event === "request_end") lines.push(line);
      } catch {
        // not one of ours
      }
    }
  }
  return lines;
}

export function summarize(events) {
  const outcomes = {};
  const notOk = [];
  const unanswered = [];
  const details = [];
  for (const e of events) {
    outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
    const at = e.eventTimestamp ? new Date(e.eventTimestamp).toISOString() : "?";
    const req = e.event?.request;
    const label = req ? `${req.method} ${new URL(req.url).pathname}` : (e.event?.cron ?? "?");
    if (e.outcome !== "ok") {
      const errors = (e.exceptions ?? []).map((x) => `${x.name}: ${x.message}`).join(" | ");
      notOk.push(`${at} ${e.outcome} ${label}${errors ? ` (${errors})` : ""}`);
    }
    const lines = requestLines(e);
    const ended = new Set(lines.filter((l) => l.event === "request_end").map((l) => l.requestId));
    for (const l of lines) {
      if (l.event === "request_start" && !ended.has(l.requestId)) {
        const open = openSteps(e);
        const stopped = open.length > 0 ? ` stopped in ${open.join(" > ")}` : "";
        const head = `${at} ${l.method} ${l.path} id=${l.requestId} outcome=${e.outcome}${stopped}`;
        unanswered.push(head);
        details.push({ head, lines: logText(e) });
      }
    }
  }
  return { events: events.length, outcomes, notOk, unanswered, details };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? "artifacts/tail.jsonl";
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    console.log(`tail-summary: no capture at ${file}`);
    process.exit(0);
  }
  const s = summarize(parseConcatenated(text));
  console.log(
    `tail-summary: ${String(s.events)} invocations, outcomes ${JSON.stringify(s.outcomes)}`,
  );
  console.log(`requests with request_start but no request_end: ${String(s.unanswered.length)}`);
  for (const u of s.unanswered) console.log(`  ${u}`);
  for (const d of s.details) {
    console.log(`every log line and exception of ${d.head}:`);
    for (const l of d.lines) console.log(`    ${l}`);
  }
  console.log(`invocations not "ok": ${String(s.notOk.length)}`);
  for (const n of s.notOk) console.log(`  ${n}`);
}
