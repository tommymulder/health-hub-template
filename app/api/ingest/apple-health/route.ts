import { isAuthorized } from "@/core/auth";
import { captureIngest, pickHeaders } from "@/core/apple/capture";
import { processRaw } from "@/core/apple/process";
import { getRuntimeSql, getToolCtx } from "@/core/runtime";
import { inTx } from "@/core/db";

export const maxDuration = 60;

// The phone's endpoint (DESIGN 4.3, D13). Its own key, INGEST_KEY, which opens
// ONLY this route: a leaked phone key can add Apple Health data and nothing else.
// Returns 200 only after the data is committed, so Health Auto Export retries on failure.
export async function POST(req: Request) {
  if (!isAuthorized(req.headers.get("x-ingest-key"), process.env.INGEST_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const text = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return Response.json({ error: "body is not JSON" }, { status: 400 });
    }
    const sql = getRuntimeSql();
    // Step 1: keep the raw body no matter what (so a parser bug never loses data).
    const res = await captureIngest(sql, payload, text.length, new Date(), pickHeaders(req.headers));
    // Step 2: parse and write the clean rows in one transaction; all or nothing.
    let processed;
    try {
      processed = await inTx(sql, (tx) => processRaw(tx, res.id, getToolCtx().timezone));
    } catch (err) {
      await sql`update raw_ingest set error = ${(err as Error).message.slice(0, 500)} where id = ${res.id}`;
      throw err; // 500: Health Auto Export shows a failure and retries; the raw body is already safe
    }
    // Names and counts only in logs and reply, never health values.
    console.log("ingest/apple-health", JSON.stringify({ id: res.id, bytes: res.bytes, samples: processed.samples, workouts: processed.workouts, droppedOura: processed.droppedOura, skipped: Object.values(processed.skipped).reduce((a, b) => a + b, 0) }));
    return Response.json({ ok: true, id: res.id, ...processed });
  } catch (err) {
    console.error("ingest/apple-health failed", (err as Error).message);
    return Response.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }
}
