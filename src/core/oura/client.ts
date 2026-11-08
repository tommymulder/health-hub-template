import { OuraDeniedError } from "./tokens";

const BASE = "https://api.ouraring.com";

// Read-only by construction: only GETs, only usercollection paths. Never webhooks
// (account-level admin actions have no place in "give Claude my health data").
// The check runs on the RESOLVED url, because "usercollection/../webhook/x" starts with the
// allowed prefix as text but normalises to /v2/webhook/x (a guard on the raw string is bypassable).
function assertAllowed(url: URL) {
  if (url.origin !== BASE || !/^\/v2\/usercollection\/[A-Za-z0-9_]+$/.test(url.pathname)) {
    throw new Error(`Refusing ${url.pathname}: only GET /v2/usercollection/<name> is allowed.`);
  }
}

export interface OuraDoc { id: string; [k: string]: unknown }
export interface HrRow { timestamp: string; bpm: number; source: string }

export interface OuraApi {
  collection(name: string, range: { start_date: string; end_date: string }): Promise<OuraDoc[]>;
  heartRate(startIso: string, endIso: string): Promise<HrRow[]>;
}

export interface OuraClientDeps {
  getAccessToken: () => Promise<string>;
  forceRefresh: (rejected: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number; // per request; a request Oura never answers counts as a network error
}

// Without a timeout, a request Oura never answers would wait for minutes and hold up the whole call.
export const REQUEST_TIMEOUT_MS = 10_000;

export function createOuraClient(deps: OuraClientDeps): OuraApi {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = deps.maxRetries ?? 3;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(path, BASE);
    assertAllowed(url);
    for (const [k, v] of Object.entries(params)) if (v !== "") url.searchParams.set(k, v);

    let token = await deps.getAccessToken();
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt >= maxRetries) throw new Error(`Oura network error: ${(err as Error).message}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.ok) return (await res.json()) as T;
      if (res.status === 401 && !refreshed) {
        // our expiry bookkeeping can be wrong (clock skew, revocation): one forced refresh, then one retry
        token = await deps.forceRefresh(token);
        refreshed = true;
        continue;
      }
      // Still 401 after a successful refresh: the login is fine (the refresh worked), this endpoint just isn't available.
      if (res.status === 401 || res.status === 403) {
        throw new OuraDeniedError(`Oura denied access to ${url.pathname.split("/").pop()} (HTTP ${res.status}): it may not be included for this account, ring or membership.`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || 500 * 2 ** attempt;
        await sleep(wait);
        continue;
      }
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Oura GET ${path} failed: ${res.status}${detail ? ` ${detail}` : ""}`);
    }
  }

  async function paged<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let next = "";
    do {
      const r = await get<{ data?: T[]; next_token?: string | null }>(path, { ...params, next_token: next });
      out.push(...(r.data ?? []));
      next = r.next_token ?? "";
    } while (next);
    return out;
  }

  return {
    collection: (name, range) => paged<OuraDoc>(`/v2/usercollection/${name}`, range),
    heartRate: (startIso, endIso) => paged<HrRow>("/v2/usercollection/heartrate", { start_datetime: startIso, end_datetime: endIso }),
  };
}
