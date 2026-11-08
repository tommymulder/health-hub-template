// Re-fetch Oura heart rate for a whole period and add any readings the hub is missing (late ring uploads that the
// incremental sync skipped, like Oct 15's 7 AM class). Safe to repeat: stored readings are skipped, nothing is changed
// or deleted, and the sync cursor is not touched.
//
//   npm run backfill:heartrate                      # dry run from the ring's first day: counts only, writes nothing
//   npm run backfill:heartrate -- --from 2026-10-01 # a shorter period
//   npm run backfill:heartrate -- --apply           # add the missing readings
//
// Never renews the Oura login (a renewal from here could race the live hub for the single-use token): it stops instead.
import { createSql } from "../src/core/db";
import { createOuraClient } from "../src/core/oura/client";
import { insertHeartRate } from "../src/core/oura/sync";
import { getAccessToken } from "../src/core/oura/tokens";

const WINDOW_DAYS = 7; // Oura rejects heart-rate ranges over 30 days; 7 keeps each step quick (same as the sync)

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const fromArg = args[args.indexOf("--from") + 1];
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.OURA_CLIENT_ID || !process.env.OURA_CLIENT_SECRET) throw new Error("DATABASE_URL, OURA_CLIENT_ID and OURA_CLIENT_SECRET must be set (.env.local)");
  const sql = createSql(url);
  try {
    const [tok] = await sql<{ ok: boolean }[]>`select expires_at > now() + interval '1 day' as ok from oauth_tokens where provider = 'oura'`;
    if (!tok?.ok) throw new Error("The Oura login expires within a day; let the live hub renew it first (any read tool), then run this again.");
    const [first] = await sql<{ value: string }[]>`select value from settings where key = 'oura_first_day'`;
    const from = args.includes("--from") ? fromArg : first?.value;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error("Give --from YYYY-MM-DD (no oura_first_day stored yet).");

    const oura = createOuraClient({
      getAccessToken: () => getAccessToken({ sql, clientId: process.env.OURA_CLIENT_ID!, clientSecret: process.env.OURA_CLIENT_SECRET! }),
      forceRefresh: async () => { throw new Error("Oura refused the login; not renewing it from a script. Nothing more was written."); },
    });

    console.log(`${apply ? "APPLY" : "DRY RUN"}: heart rate from ${from} to now, in ${WINDOW_DAYS}-day windows`);
    let totalOura = 0, totalMissing = 0, totalAdded = 0;
    const nowMs = Date.now();
    for (let start = Date.parse(`${from}T00:00:00Z`); start < nowMs; start += WINDOW_DAYS * 86_400_000) {
      const end = Math.min(start + WINDOW_DAYS * 86_400_000, nowMs);
      const rows = await oura.heartRate(new Date(start).toISOString(), new Date(end).toISOString());
      const have = await sql<{ k: string }[]>`
        select (extract(epoch from ts) * 1000)::bigint::text || '|' || source as k from hr_samples where ts >= ${new Date(start)} and ts < ${new Date(end)}`;
      const stored = new Set(have.map((r) => r.k));
      const missing = rows.filter((r) => Number.isFinite(r.bpm) && !stored.has(`${Date.parse(r.timestamp)}|oura:${r.source}`));
      totalOura += rows.length;
      totalMissing += missing.length;
      if (apply && missing.length) totalAdded += await insertHeartRate(sql, missing);
      if (missing.length) console.log(`  ${new Date(start).toISOString().slice(0, 10)}: Oura ${rows.length}, hub missing ${missing.length}`);
    }
    console.log(`Oura readings checked: ${totalOura}. Missing in the hub: ${totalMissing}.${apply ? ` Added: ${totalAdded}.` : " Run again with --apply to add them."}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => { console.error((err as Error).message); process.exit(1); });
