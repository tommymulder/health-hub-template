import { randomUUID } from "node:crypto";
import { inTx, type Sql } from "../db";
import { HevyWriteError } from "../hevy/write";
import { ToolError } from "./context";

// Shared by every tool that writes to Hevy (routines, class workouts, custom exercises).
// Hevy has no delete, so each write goes: validate -> guard + write-ahead audit row -> ONE attempt -> finalise.
export type Outcome = "pending" | "ok" | "unconfirmed" | "rejected";

export async function openAudit(sql: Sql, a: { kind: string; action: "create" | "update"; hevyId: string; title: string; request: unknown; previous?: unknown }): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into hevy_writes (hevy_id, kind, action, outcome, title, request, previous)
    values (${a.hevyId}, ${a.kind}, ${a.action}, 'pending', ${a.title}, ${sql.json(a.request as never)}, ${a.previous === undefined ? null : sql.json(a.previous as never)})
    returning id`;
  return Number(row.id);
}

export const pendingId = () => `pending:${randomUUID()}`;

// Never lets a bookkeeping failure hide the fact that Hevy WAS written.
export async function closeAudit(sql: Sql, id: number, outcome: Outcome, extra: { hevyId?: string; response?: unknown } = {}): Promise<string | null> {
  try {
    await sql`
      update hevy_writes set outcome = ${outcome},
        hevy_id = coalesce(${extra.hevyId ?? null}, hevy_id),
        response = ${extra.response === undefined ? null : sql.json(extra.response as never)}
      where id = ${id}`;
    return null;
  } catch (err) {
    return `The write happened, but updating the audit log failed (${(err as Error).message}).`;
  }
}

export type Reservation<D> = { existing: D; auditId?: undefined } | { auditId: number; existing?: undefined };

// Double-submit guard + write-ahead row, atomically: the advisory lock serialises concurrent calls with the same key,
// `findDuplicate` decides what counts as "already done", and the pending row is inserted before the caller sends anything.
export async function reserveWrite<D>(
  sql: Sql,
  a: { lockKey: string; kind: string; title: string; request: unknown; findDuplicate: (tx: Sql) => Promise<D | null> },
): Promise<Reservation<D>> {
  return inTx(sql, async (tx): Promise<Reservation<D>> => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${a.lockKey}, 0))`;
    const dup = await a.findDuplicate(tx);
    if (dup) return { existing: dup };
    return { auditId: await openAudit(tx, { kind: a.kind, action: "create", hevyId: pendingId(), title: a.title, request: a.request }) };
  });
}

// One attempt, then record exactly what is known. `thing` names what was being written; `whereToLook` says where the user can check.
export async function attempt<T>(
  sql: Sql,
  auditId: number,
  a: { what: "create" | "update"; thing: string; whereToLook: string },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HevyWriteError && !err.unconfirmed) {
      await closeAudit(sql, auditId, "rejected", { response: { error: err.message, status: err.status } });
      throw new ToolError(`${err.message} Nothing was ${a.what === "create" ? "created" : "changed"} in Hevy.`);
    }
    await closeAudit(sql, auditId, "unconfirmed", { response: { error: (err as Error).message } });
    throw new ToolError(
      `Hevy didn't give a clear answer (${(err as Error).message}), so the ${a.thing} may or may not have been ${a.what === "create" ? "created" : "updated"}. ` +
        `Check ${a.whereToLook} before trying again; retrying now could create a duplicate that can't be deleted from here.`,
    );
  }
}
