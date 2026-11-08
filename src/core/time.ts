// UTC inside, local only when talking about "days" (DESIGN D7).
// en-CA formats dates as YYYY-MM-DD, which is what Postgres `date` wants.
export function localDate(instant: string | Date, timeZone: string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${String(instant)}`);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Pure calendar arithmetic on YYYY-MM-DD strings (no timezones involved, so no DST traps).
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

// Monday of the week containing `date` (ISO weeks, same as Postgres date_trunc('week')).
export function weekStart(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

// "2026-10-11 01:13" in the given zone: a bare "01:13" is ambiguous about WHICH night.
export function localDateTime(instant: string | Date, timeZone: string): string {
  return `${localDate(instant, timeZone)} ${localTime(instant, timeZone)}`;
}

// "07:15" in the given zone, for telling morning from evening sessions.
export function localTime(instant: string | Date, timeZone: string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

// Seconds-precision UTC offset of `timeZone` at the given instant, in ms (PDT = -7h).
function offsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(instantMs / 1000) * 1000;
}

// The inverse problem: a timestamp whose UTC clock reading is really a LOCAL
// wall-clock time (what a CSV import into Hevy becomes when the file had no timezone and Hevy assumed UTC).
// Returns the true instant at which `timeZone`'s clock showed those digits.
export function wallClockToInstant(isoUtc: string, timeZone: string): Date {
  const asUtc = new Date(isoUtc).getTime();
  if (Number.isNaN(asUtc)) throw new Error(`Invalid date: ${isoUtc}`);
  let t = asUtc - offsetMs(asUtc, timeZone);
  const off = offsetMs(t, timeZone); // the offset may differ on the other side of a DST change
  if (asUtc - off !== t) t = asUtc - off;
  return new Date(t);
}
