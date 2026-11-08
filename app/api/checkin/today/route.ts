import { moduleOff } from "../../moduleGate";
import { isAuthorized } from "@/core/auth";
import { localDate } from "@/core/time";
import { getToolCtx } from "@/core/runtime";

export const maxDuration = 60;

// The 9:00 automation asks only this. The reply is a yes/no, never the rating.
// `status` is plain text because Shortcuts treats JSON `false` as "has a value":
// an If on `logged` can't tell logged from not logged. Compare `status` instead.
export async function GET(req: Request) {
  const off = moduleOff("checkins");
  if (off) return off;
  if (!isAuthorized(req.headers.get("x-checkin-key"), process.env.CHECKIN_KEY)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const ctx = getToolCtx();
    const today = localDate(new Date(), ctx.timezone);
    const rows = await ctx.sql<{ n: number }[]>`select 1 as n from morning_checkins where day = ${today} limit 1`;
    const logged = rows.length > 0;
    return Response.json({ logged, status: logged ? "logged" : "not_logged" });
  } catch (err) {
    console.error("checkin/today failed", (err as Error).message);
    return Response.json({ error: "check-in failed" }, { status: 500 });
  }
}
