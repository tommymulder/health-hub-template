import type { Sql } from "./db";

// Per-source bookkeeping shared by the Hevy and Oura syncs.
export async function getState(sql: Sql, source: string) {
  const [row] = await sql<{ cursor: string | null; last_run_at: Date | null; last_error: string | null }[]>`
    select cursor, last_run_at, last_error from sync_state where source = ${source}`;
  return row ?? null;
}

export async function setState(
  sql: Sql,
  source: string,
  patch: { cursor?: string | null; last_run_at?: Date; last_ok_at?: Date; last_error?: string | null },
) {
  // COALESCE keeps old values for fields we didn't pass; cursor uses a flag so
  // that "don't touch" and "set to null" stay different things.
  await sql`
    insert into sync_state (source, cursor, last_run_at, last_ok_at, last_error)
    values (${source}, ${patch.cursor ?? null}, ${patch.last_run_at ?? null},
            ${patch.last_ok_at ?? null}, ${patch.last_error ?? null})
    on conflict (source) do update set
      cursor      = case when ${patch.cursor !== undefined} then excluded.cursor else sync_state.cursor end,
      last_run_at = coalesce(excluded.last_run_at, sync_state.last_run_at),
      last_ok_at  = coalesce(excluded.last_ok_at, sync_state.last_ok_at),
      last_error  = case when ${patch.last_error !== undefined} then excluded.last_error else sync_state.last_error end`;
}

