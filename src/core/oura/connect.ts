import { randomBytes } from "node:crypto";
import type { Sql } from "../db";
import { inTx } from "../db";
import { AUTHORIZE_URL, OURA_SCOPES, TOKEN_URL, saveTokens } from "./tokens";

// One-time "connect Oura" flow. Instead of a shared secret in a URL, the hub issues a random,
// single-use, 10-minute `state` and builds Oura's authorize link around it. The public callback
// accepts only a state we issued, once: that is the CSRF protection AND the access control.
const STATE_MINUTES = 10;

export class OuraConnectError extends Error {}

export async function startOuraConnect(sql: Sql, cfg: { clientId: string; redirectUri: string }) {
  const state = randomBytes(24).toString("hex");
  await sql`insert into oauth_states (state, provider) values (${state}, 'oura')`;
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", OURA_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return { url: url.toString(), redirect_uri: cfg.redirectUri, scopes: OURA_SCOPES, expires_in_minutes: STATE_MINUTES };
}

export interface CompleteDeps {
  sql: Sql;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  provider?: string;
  fetchImpl?: typeof fetch;
}

export async function completeOuraConnect(
  deps: CompleteDeps,
  params: { state?: string | null; code?: string | null; error?: string | null },
): Promise<{ scope: string }> {
  if (params.error) throw new OuraConnectError("Oura didn't grant access (it was declined or cancelled). Ask for connect_oura to try again.");
  if (!params.state || !params.code) throw new OuraConnectError("This link is incomplete. Ask for connect_oura for a fresh one.");

  // Consume the state atomically: it exists, is ours, is unused and is under 10 minutes old.
  const used = await deps.sql`
    update oauth_states set used_at = now()
    where state = ${params.state} and provider = 'oura' and used_at is null
      and created_at > now() - ${STATE_MINUTES} * interval '1 minute'
    returning state`;
  if (used.count === 0) throw new OuraConnectError("This link is expired or was already used. Ask for connect_oura for a fresh one.");

  const res = await (deps.fetchImpl ?? fetch)(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code", code: params.code, redirect_uri: deps.redirectUri,
      client_id: deps.clientId, client_secret: deps.clientSecret,
    }),
  });
  if (!res.ok) throw new OuraConnectError(`Oura refused the sign-in (HTTP ${res.status}). Check the redirect URI registered in Oura's developer portal, then ask for connect_oura again.`);
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string };

  const provider = deps.provider ?? "oura";
  await inTx(deps.sql, async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${"oauth_refresh:" + provider}, 0))`; // never interleave with a refresh
    await saveTokens(tx, provider, t);
  });
  return { scope: t.scope ?? OURA_SCOPES.join(" ") };
}
