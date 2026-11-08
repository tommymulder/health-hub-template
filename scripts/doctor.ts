// npm run doctor : is the hub set up? Prints PASS / FAIL / SKIP per check, never a value. Exit code 1 when anything fails.
import { createSql } from "../src/core/db";
import { exitCode, format, runDoctor } from "../src/core/doctor";
import { createHevyClient } from "../src/core/hevy/client";
import { isConnected } from "../src/core/oura/tokens";

try { process.loadEnvFile(".env.local"); } catch { /* production env vars may already be set */ }

async function main() {
  const env = process.env;
  const sql = env.DATABASE_URL ? (() => { try { return createSql(env.DATABASE_URL!); } catch { return null; } })() : null;
  const checks = await runDoctor(env, {
    database: async () => {
      await sql!`select 1`;
      const rows = await sql!<{ name: string; rls: boolean }[]>`
        select c.relname as name, c.relrowsecurity as rls from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`;
      return { tables: rows };
    },
    hevy: env.HEVY_API_KEY ? () => createHevyClient({ apiKey: env.HEVY_API_KEY! }).getWorkoutCount() : undefined,
    ouraConnected: () => isConnected(sql!),
  });
  for (const c of checks) console.log(format(c));
  const failed = checks.filter((c) => c.status === "fail").length;
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
  await sql?.end({ timeout: 5 });
  process.exit(exitCode(checks));
}
main().catch((e) => { console.error("doctor crashed:", String((e as Error).message ?? e).replace(/postgres(ql)?:\/\/\S+/g, "[url]")); process.exit(2); });
