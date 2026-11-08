export function ping(now: Date = new Date()): { ok: true; time: string } {
  return { ok: true, time: now.toISOString() };
}
