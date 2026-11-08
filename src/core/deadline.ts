// A promise with a stopwatch: resolves to the work's result, or to TIMED_OUT if the work takes longer
// than `ms`. It does NOT cancel the work (JavaScript can't); callers make sure abandoned work is bounded
// (every network call has its own timeout) and harmless (every write is an idempotent upsert).
export const TIMED_OUT = Symbol("timed out");

export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
