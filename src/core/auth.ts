import { createHash, timingSafeEqual } from "node:crypto";

// Header Claude's connector sends. Anthropic only allows pre-approved custom
// header names, and x-api-key is on that list (X-Hub-Key was not).
export const HUB_KEY_HEADER = "x-api-key";

// Compare two strings without leaking, via timing, how many leading characters
// matched. Hashing first gives both sides the same length, which
// timingSafeEqual requires, and also hides the secret's length.
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

// True only if a secret is configured AND the presented key matches it.
// A missing or empty secret must never authorize anything (fail closed).
export function isAuthorized(
  presented: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !presented) return false;
  return constantTimeEqual(presented, secret);
}

// Vercel cron calls us with `Authorization: Bearer <CRON_SECRET>`.
export function isBearerAuthorized(
  authorization: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  return isAuthorized(authorization.slice("Bearer ".length), secret);
}
