import { readFileSync } from "node:fs";
import { computeWeeklyUsage, formatUsageReport, parseAuditLines } from "../src/metrics/usage.js";

/**
 * `pnpm metrics [audit.jsonl]` — weekly usage from the JSON-lines audit log.
 * Defaults to `AUDIT_LOG_FILE`, then `./audit.log`.
 */
const file = process.argv[2] ?? process.env.AUDIT_LOG_FILE ?? "audit.log";

let text: string;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(
    `metrics: cannot read ${file}. Pass a path or set AUDIT_LOG_FILE (the bot appends there when AUDIT_LOG_FILE is set).`,
  );
  process.exit(1);
}

const report = computeWeeklyUsage(parseAuditLines(text));
console.log(`# mena-assistant usage — ${file}`);
console.log(formatUsageReport(report));
