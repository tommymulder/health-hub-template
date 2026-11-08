import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  // DB tests make many round-trips to a remote database. Each test file opens its own connection and Supabase's session-mode
// pooler allows 15 clients in all, so cap the parallel files (53+ files at once hit "max clients reached" and lock deadlocks).
test: { include: ["test/**/*.test.ts"], testTimeout: 60_000, maxWorkers: 6 },
});
