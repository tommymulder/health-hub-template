// Loose exercise-name matching: "bench" / "bench press" / "RDL" should find
// the right Hevy exercise without exact titles.
const ALIASES: Record<string, string> = {
  rdl: "romanian deadlift",
  ohp: "overhead press",
  db: "dumbbell",
  bb: "barbell",
};

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((t) => ALIASES[t] ?? t)
    .join(" ");
}

const stem = (t: string) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);
const tokens = (s: string) => normalize(s).split(" ").filter(Boolean).map(stem);

export function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

const tokenMatches = (q: string, t: string) =>
  q === t || (q.length >= 4 && t.startsWith(q)) || (q.length >= 5 && lev(q, t) <= 1);

// 0 = no match. Higher = better. Every query word must appear in the title.
export function scoreTitle(query: string, title: string): number {
  const qn = normalize(query);
  if (!qn) return 0;
  if (normalize(title) === qn) return 1000;
  const qt = tokens(query);
  const tt = tokens(title);
  if (!qt.every((q) => tt.some((t) => tokenMatches(q, t)))) return 0;
  let score = 500 - Math.max(0, tt.length - qt.length) * 10; // fewer extra words = closer
  // "bench press" should favour "Bench Press (Barbell)" over "Incline Bench Press (Barbell)"
  if (normalize(title.replace(/\(.*?\)/g, " ")) === qn) score += 200;
  return score;
}

export interface Rankable {
  title: string;
  sessions: number; // how often the user has done it; breaks ties and ranks done-first
}

export function rankExercises<T extends Rankable>(query: string, items: T[]): { item: T; score: number }[] {
  return items
    .map((item) => ({ item, score: scoreTitle(query, item.title) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score || b.item.sessions - a.item.sessions || a.item.title.length - b.item.title.length,
    );
}
