// One-time review and repair of the classes logged before Phase 19 (DESIGN Phase 19 F). Hub only: nothing goes to
// Hevy and nothing is deleted. Dry run by default; --apply writes only rounds, total, share and optional, in one
// transaction, and a second --apply changes 0 rows.
//
//   npm run review:class-boards                                   # the review: what isn't countable, and why (read-only)
//   npm run review:class-boards -- --fixes scripts/class-board-fixes.json          # what the fix file WOULD change (dry run)
//   npm run review:class-boards -- --fixes scripts/class-board-fixes.json --apply  # write it (after you've reviewed the table)
import { readFileSync } from "node:fs";
import { createSql } from "../src/core/db";
import { applyBoardFixes, parseBoardFixes, reviewClasses } from "../src/core/classes/boardFixes";

try { process.loadEnvFile(".env.local"); } catch { /* env may come from the shell */ }

const pc = (n: number | null) => (n === null ? "not countable" : `${n}%`);

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const fixesPath = args.includes("--fixes") ? args[args.indexOf("--fixes") + 1] : undefined;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set (.env.local)");
  const sql = createSql(url);
  try {
    if (!fixesPath) {
      if (apply) throw new Error("--apply needs --fixes <file>.");
      for (const c of await reviewClasses(sql)) {
        console.log(`\n#${c.session_id}  ${c.date}  ${c.title}  [${c.class_type}]  completion ${c.completion_pct ?? "not countable"}%  (${c.counted})`);
        for (const n of c.not_counted) console.log(`   not countable: block ${n.block} ${n.movement}: ${n.reason}`);
        if (c.blocks_without_rounds.length) console.log(`   blocks with no posted rounds: ${c.blocks_without_rounds.join(", ")}`);
        for (const m of c.board_mentions) console.log(`   board: ${m}`);
      }
      return;
    }
    const fixes = parseBoardFixes(JSON.parse(readFileSync(fixesPath, "utf8")));
    const r = await applyBoardFixes(sql, fixes, { apply });
    console.log(`${apply ? "APPLIED" : "DRY RUN"}: ${r.changes.blocks} block(s), ${r.changes.movements} movement(s), ${r.changes.planned} stored board copy(ies).`);
    for (const d of r.details) console.log(`   ${d}`);
    console.log("\nCompletion before -> after:");
    for (const c of r.completion) console.log(`   #${c.session_id} ${c.date} ${c.title}: ${pc(c.before)} (${c.counted_before}) -> ${pc(c.after)} (${c.counted_after})`);
    if (!apply) console.log("Nothing was written. Add --apply to write these.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => { console.error((err as Error).message); process.exit(1); });
