import type { HevyApi, HevyEvent, HevyTemplate, HevyWorkout, Page } from "./types";

export class HevyError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HevyError";
  }
}

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number; // per request; a request Hevy never answers counts as a network error
}

// Without a timeout, a request Hevy never answers would wait for minutes and hold up the whole call.
// Reads only: the writer (write.ts) has no timeout on purpose, because a timed-out write is ambiguous.
export const REQUEST_TIMEOUT_MS = 10_000;

const WORKOUT_PAGE_SIZE = 10; // API maximum for /workouts and /workouts/events
const TEMPLATE_PAGE_SIZE = 100; // API maximum for /exercise_templates

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export function createHevyClient(opts: ClientOptions): HevyApi {
  const base = opts.baseUrl ?? "https://api.hevyapp.com";
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  // GET only. Retrying a GET is safe; we never retry anything that writes.
  async function get<T>(path: string, query: Record<string, string | number>): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));

    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await doFetch(url, { headers: { "api-key": opts.apiKey, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt >= maxRetries) throw new HevyError(`Hevy network error: ${(err as Error).message}`);
        await sleep(backoff(attempt));
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      if (RETRYABLE(res.status) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw new HevyError(`Hevy GET ${path} failed: ${res.status}`, res.status);
    }
  }

  return {
    async getWorkoutsPage(page): Promise<Page<HevyWorkout>> {
      const r = await get<{ page: number; page_count: number; workouts: HevyWorkout[] }>(
        "/v1/workouts",
        { page, pageSize: WORKOUT_PAGE_SIZE },
      );
      return { page: r.page, page_count: r.page_count, items: r.workouts };
    },
    async getEventsPage(since, page): Promise<Page<HevyEvent>> {
      const r = await get<{ page: number; page_count: number; events?: HevyEvent[]; workouts?: unknown[] }>(
        "/v1/workouts/events",
        { since, page, pageSize: WORKOUT_PAGE_SIZE },
      );
      // Observed 2026-10-11: with nothing new, the real API returns
      // {"workouts": []} instead of the documented {"events": []}. Accept that
      // one known quirk, but fail loudly on any other shape so we never
      // silently drop events.
      const items = r.events ?? (Array.isArray(r.workouts) && r.workouts.length === 0 ? [] : undefined);
      if (!items) throw new HevyError("Unexpected shape from /v1/workouts/events");
      return { page: r.page, page_count: r.page_count, items };
    },
    async getTemplatesPage(page): Promise<Page<HevyTemplate>> {
      const r = await get<{ page: number; page_count: number; exercise_templates: HevyTemplate[] }>(
        "/v1/exercise_templates",
        { page, pageSize: TEMPLATE_PAGE_SIZE },
      );
      return { page: r.page, page_count: r.page_count, items: r.exercise_templates };
    },
    async getWorkoutCount() {
      const r = await get<{ workout_count: number }>("/v1/workouts/count", {});
      return r.workout_count;
    },
  };
}

// 0.5s, 1s, 2s, 4s ...
const backoff = (attempt: number) => 500 * 2 ** attempt;
