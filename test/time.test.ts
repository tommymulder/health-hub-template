import { describe, it, expect } from "vitest";
import { localDate } from "@/core/time";

const LA = "America/Los_Angeles";

describe("localDate", () => {
  it("uses the local calendar day, not the UTC day", () => {
    // 2026-10-11 03:00 UTC is still Oct 10 evening in Pacific time (PDT, UTC-7)
    expect(localDate("2026-10-11T03:00:00Z", LA)).toBe("2026-10-10");
    expect(localDate("2026-10-11T07:00:00Z", LA)).toBe("2026-10-11");
  });

  it("is correct on both sides of the fall-back DST change (2026-11-01 02:00 PDT -> 01:00 PST)", () => {
    // Both of these are 1:30am local (once as PDT, once as PST): same local day.
    expect(localDate("2026-11-01T08:30:00Z", LA)).toBe("2026-11-01");
    expect(localDate("2026-11-01T09:30:00Z", LA)).toBe("2026-11-01");
    // 23:59 PST on Nov 1 is 07:59Z; one minute later is Nov 2 local.
    expect(localDate("2026-11-02T07:59:00Z", LA)).toBe("2026-11-01");
    expect(localDate("2026-11-02T08:00:00Z", LA)).toBe("2026-11-02");
  });

  it("is correct across the spring-forward change (2026-03-08)", () => {
    expect(localDate("2026-03-08T09:59:00Z", LA)).toBe("2026-03-08"); // 01:59 PST
    expect(localDate("2026-03-09T06:59:00Z", LA)).toBe("2026-03-08"); // 23:59 PDT
    expect(localDate("2026-03-09T07:00:00Z", LA)).toBe("2026-03-09");
  });

  it("rejects invalid input", () => expect(() => localDate("nope", LA)).toThrow());
});

import { wallClockToInstant } from "@/core/time";

describe("wallClockToInstant (CSV import: local clock labelled as UTC)", () => {
  const iso = (s: string) => wallClockToInstant(s, LA).toISOString();
  it("turns a UTC-labelled local time into the real instant (PDT = UTC-7)", () => {
    // an "Afternoon Workout": CSV said 17:17:43 local, Hevy stored 17:17:43Z
    expect(iso("2026-10-10T17:17:43Z")).toBe("2026-10-11T00:17:43.000Z");
  });
  it("uses UTC-8 in winter", () => expect(iso("2026-01-15T07:00:00Z")).toBe("2026-01-15T15:00:00.000Z"));
  it("fixes the calendar day for early-morning workouts", () => {
    // stored 05:30Z really means 05:30 local on Mar 30; the old reading put it on Mar 29
    expect(localDate("2026-03-30T05:30:00Z", LA)).toBe("2026-03-29");
    const real = wallClockToInstant("2026-03-30T05:30:00Z", LA);
    expect(real.toISOString()).toBe("2026-03-30T12:30:00.000Z");
    expect(localDate(real, LA)).toBe("2026-03-30");
  });
  it("is right on both sides of the DST changes", () => {
    expect(iso("2026-03-08T12:00:00Z")).toBe("2026-03-08T19:00:00.000Z"); // PDT after spring-forward
    expect(iso("2026-03-07T12:00:00Z")).toBe("2026-03-07T20:00:00.000Z"); // PST before it
    expect(iso("2026-11-01T12:00:00Z")).toBe("2026-11-01T20:00:00.000Z"); // PST after fall-back
    expect(iso("2026-10-31T12:00:00Z")).toBe("2026-10-31T19:00:00.000Z"); // PDT before it
  });
  it("keeps seconds and rejects garbage", () => {
    expect(iso("2026-10-10T17:17:43Z").slice(14, 19)).toBe("17:43");
    expect(() => wallClockToInstant("nope", LA)).toThrow();
  });
});
