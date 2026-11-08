// Copy the heart-rate series inside every STORED sleep document into the heart-rate timeline (hr_samples, source
// oura:sleep), so nights show up next to the daytime readings. No Oura calls: it only reads oura_documents. Never
// updates or deletes; readings already stored are skipped, so it is safe to repeat.
//
//   npm run backfill:sleep-hr            # dry run: counts only, writes nothing
//   npm run backfill:sleep-hr -- --apply # add the missing readings
import { createSql } from "../src/core/db";
import { insertHeartRate, sleepHeartRateRows } from "../src/core/oura/sync";

try { process.loadEnvFile(".env.local"); } catch { /* env may come from the shell */ }

async function main() {
  const apply = process.argv.includes("--apply");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set (.env.local)");
  const sql = createSql(url);
  try {
    const docs = await sql<{ id: string; data: Record<string, unknown> }[]>`select id, data from oura_documents where collection = 'sleep' order by day`;
    let readings = 0, missing = 0, added = 0;
    for (let i = 0; i < docs.length; i += 25) {
      const rows = docs.slice(i, i + 25).flatMap((d) => sleepHeartRateRows(d.data));
      readings += rows.length;
      if (!rows.length) continue;
      const have = await sql<{ k: string }[]>`
        select (extract(epoch from ts) * 1000)::bigint::text as k from hr_samples
        where source = 'oura:sleep' and ts between ${new Date(Math.min(...rows.map((r) => Date.parse(r.timestamp))))} and ${new Date(Math.max(...rows.map((r) => Date.parse(r.timestamp))))}`;
      const stored = new Set(have.map((r) => r.k));
      const todo = rows.filter((r) => !stored.has(String(Date.parse(r.timestamp))));
      missing += todo.length;
      if (apply && todo.length) await insertHeartRate(sql, todo);
      if (apply) added += todo.length;
    }
    console.log(`${apply ? "APPLY" : "DRY RUN"}: ${docs.length} sleep documents, ${readings} readings in them, ${missing} not yet in hr_samples.${apply ? ` Added: ${added}.` : " Run again with --apply to add them."}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => { console.error((err as Error).message); process.exit(1); });
