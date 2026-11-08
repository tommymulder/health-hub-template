import { randomUUID } from "node:crypto";
import type { Sql } from "./db";

// A lease: "I'm doing this job; everyone else skip it." Claude often calls two tools at once, and each call may
// land on a different server copy, so an in-memory flag can't see the other one. The claim lives in the database
// instead, and it is ONE atomic statement (insert, or take over only if the holder's claim has expired), so two
// callers can never both win. If the holder dies, its claim simply expires after `ttlSec`.
// Returns a release function, or null when someone else holds the lease.
export async function claimLease(sql: Sql, name: string, ttlSec: number): Promise<(() => Promise<void>) | null> {
  const key = `lease:${name}`;
  const id = randomUUID();
  const rows = await sql`
    insert into settings (key, value) values (${key}, now()::text || '|' || ${id})
    on conflict (key) do update set value = excluded.value
      where split_part(settings.value, '|', 1)::timestamptz < now() - make_interval(secs => ${ttlSec})
    returning key`;
  if (rows.length === 0) return null;
  // Release only OUR claim: if it expired and someone else took over, leave theirs alone.
  return async () => {
    await sql`delete from settings where key = ${key} and split_part(value, '|', 2) = ${id}`;
  };
}
