// Import lab results from Apple's "Export All Health Data" (DESIGN 4.4, route 1).
//
//   npm run import:apple-export -- ~/Downloads/export.zip                 # dry run: prints what it found, writes nothing
//   npm run import:apple-export -- ~/Downloads/export.zip --apply         # writes to the database
//   ... --label Zq9xK="Example Lab"                                 # name a feed the export does not name (repeatable)
//
// Re-running with the same export changes nothing. Prints counts and dates only, never result values.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSql } from "../src/core/db";
import { parseClinicalRecords } from "../src/core/labs/fhir";
import { summarizeImport, upsertFhirLabs } from "../src/core/labs/import";

try { process.loadEnvFile(".env.local"); } catch { /* env may come from the shell */ }

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const labels: Record<string, string> = {};
const paths: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--label") {
    const [k, ...v] = (args[++i] ?? "").split("=");
    if (!k || v.length === 0) throw new Error('--label needs prefix=Name, e.g. --label Zq9xK="Example Lab"');
    labels[k] = v.join("=");
  } else if (!args[i].startsWith("--")) paths.push(args[i]);
}
if (paths.length !== 1) throw new Error("Usage: npm run import:apple-export -- <export.zip | apple_health_export folder> [--apply] [--label prefix=Name]");

const timeZone = process.env.TIMEZONE || "America/Los_Angeles";
const input = paths[0].replace(/^~/, process.env.HOME ?? "~");
let workDir: string | null = null;
let recordsDir: string;
if (statSync(input).isDirectory()) {
  recordsDir = statSync(join(input, "clinical-records"), { throwIfNoEntry: false })?.isDirectory() ? join(input, "clinical-records") : join(input, "apple_health_export", "clinical-records");
} else {
  // Unpack ONLY the medical records (about 20 MB) into a fresh temporary folder; the 1.5 GB of other data is never touched.
  workDir = mkdtempSync(join(tmpdir(), "health-export-"));
  execFileSync("unzip", ["-q", "-o", input, "apple_health_export/clinical-records/*", "-d", workDir]);
  recordsDir = join(workDir, "apple_health_export", "clinical-records");
}

async function main() {
  try {
    const resources: unknown[] = [];
    let unreadable = 0;
    for (const f of readdirSync(recordsDir).filter((n) => n.endsWith(".json"))) {
      try { resources.push(JSON.parse(readFileSync(join(recordsDir, f), "utf8"))); } catch { unreadable++; }
    }
    const parsed = parseClinicalRecords(resources, timeZone, labels);
    console.log(`Read ${resources.length} medical records${unreadable ? ` (${unreadable} unreadable files skipped)` : ""}.`);

    if (!apply) {
      console.log(JSON.stringify(summarizeImport(parsed, timeZone), null, 2));
      console.log("\nDry run: nothing was written. Add --apply to save these results.");
    } else {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error("DATABASE_URL is not set (.env.local)");
      const sql = createSql(url);
      try {
        const counts = await upsertFhirLabs(sql, parsed.results);
        console.log(JSON.stringify(summarizeImport(parsed, timeZone, counts), null, 2));
        console.log(`\nSaved: ${counts.new} new, ${counts.already_there} already there.`);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(String((err as Error).message ?? err));
  process.exit(1);
});
