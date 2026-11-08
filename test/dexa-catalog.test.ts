import { describe, it, expect } from "vitest";
import { DEXA_PANEL, dexaId, dexaName, dexaWarnings, validDexaCombos } from "@/core/labs/dexa";

// Synthetic numbers only: nothing here is a real scan.
describe("dexaName: one canonical name per metric x region x side", () => {
  it.each([
    [{ metric: "lean_mass" }, "DEXA lean mass", "lb"],
    [{ metric: "body_fat_pct" }, "DEXA body fat %", "%"],
    [{ metric: "visceral_fat_area" }, "DEXA visceral fat area", "in²"],
    [{ metric: "android_gynoid_ratio" }, "DEXA android/gynoid ratio", null],
    [{ metric: "bmd" }, "DEXA BMD", "g/cm²"],
    [{ metric: "bmd_t_score" }, "DEXA BMD T-score", null],
    [{ metric: "rsmi" }, "DEXA RSMI", "kg/m²"],
    [{ metric: "rmr_estimate" }, "DEXA RMR estimate", "kcal/day"],
    [{ metric: "lean_mass", region: "arms", side: "left" }, "DEXA lean mass (left arm)", "lb"],
    [{ metric: "lean_mass", region: "arms", side: "both" }, "DEXA lean mass (arms)", "lb"],
    [{ metric: "lean_mass", region: "arms" }, "DEXA lean mass (arms)", "lb"],
    [{ metric: "fat_mass", region: "legs", side: "right" }, "DEXA fat mass (right leg)", "lb"],
    [{ metric: "total_mass", region: "trunk", side: "left" }, "DEXA total mass (left trunk)", "lb"],
    [{ metric: "region_fat_pct", region: "android" }, "DEXA region fat % (android)", "%"],
    [{ metric: "region_fat_pct", region: "gynoid" }, "DEXA region fat % (gynoid)", "%"],
  ] as const)("%j -> %s", (ref, name, unit) => {
    expect(dexaName(ref, unit === "lb" ? "lb" : undefined)).toMatchObject({ ok: true, name, unit });
  });

  it("android and gynoid have no sides", () => {
    expect(dexaName({ metric: "lean_mass", region: "android", side: "left" }, undefined)).toMatchObject({ ok: false });
    expect(dexaName({ metric: "lean_mass", region: "gynoid", side: "right" }, undefined)).toMatchObject({ ok: false });
  });
  it("whole-body-only metrics refuse a region; region_fat_pct needs one", () => {
    expect(dexaName({ metric: "bmd", region: "arms" }, undefined)).toMatchObject({ ok: false });
    expect(dexaName({ metric: "region_fat_pct" }, undefined)).toMatchObject({ ok: false, error: expect.stringMatching(/body_fat_pct/) });
  });
  it("a wrong unit is refused; kg is fine for a mass; a mass with no unit is refused (never guess a unit)", () => {
    expect(dexaName({ metric: "body_fat_pct" }, "lb")).toMatchObject({ ok: false, error: expect.stringMatching(/%/) });
    expect(dexaName({ metric: "lean_mass" }, "kg")).toMatchObject({ ok: true, unit: "kg" });
    expect(dexaName({ metric: "lean_mass" }, "lbs")).toMatchObject({ ok: true, unit: "lb" });
    expect(dexaName({ metric: "lean_mass" }, undefined)).toMatchObject({ ok: false, error: expect.stringMatching(/lb or kg/) });
    expect(dexaName({ metric: "bmd" }, undefined)).toMatchObject({ ok: true, unit: "g/cm²" }); // unit is fixed, so it may be omitted
  });
  it("an unknown metric or region is refused with the valid choices", () => {
    const r = dexaName({ metric: "muscle_age" }, undefined);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/lean_mass/);
    expect(dexaName({ metric: "lean_mass", region: "head" }, undefined)).toMatchObject({ ok: false });
  });
  it("lists every valid combination and each builds a name", () => {
    const all = validDexaCombos();
    expect(all.length).toBeGreaterThan(40);
    for (const c of all) expect(dexaName(c, c.unit === "mass" ? "lb" : undefined)).toMatchObject({ ok: true });
    expect(new Set(all.map((c) => dexaName(c, c.unit === "mass" ? "lb" : undefined)).map((r) => (r as { name: string }).name)).size).toBe(all.length);
  });
});

describe("dexaId: replaces on re-log, so it ignores the value", () => {
  it("same name + date + clinic = same id; a different date or clinic differs", () => {
    const a = dexaId("DEXA lean mass", "2031-01-05", "Clinic A");
    expect(dexaId("DEXA lean mass", "2031-01-05", "clinic a ")).toBe(a);
    expect(dexaId("DEXA lean mass", "2031-01-06", "Clinic A")).not.toBe(a);
    expect(dexaId("DEXA lean mass", "2031-01-05", "Clinic B")).not.toBe(a);
    expect(dexaId("DEXA fat mass", "2031-01-05", "Clinic A")).not.toBe(a);
  });
  it("panel is DEXA", () => expect(DEXA_PANEL).toBe("DEXA"));
});

describe("dexaWarnings: plausibility checks that never block", () => {
  const row = (name: string, value: number, unit = "lb") => ({ name, value, unit });
  it("is quiet when the numbers add up", () => {
    expect(dexaWarnings([
      row("DEXA total mass", 200), row("DEXA lean mass", 150), row("DEXA fat mass", 44), row("DEXA bone mass", 6), row("DEXA body fat %", 22, "%"),
      row("DEXA total mass (arms)", 30), row("DEXA total mass (left arm)", 15), row("DEXA total mass (right arm)", 15.2),
    ])).toEqual([]);
  });
  it("flags left + right that miss the total by more than 0.3 lb", () => {
    const w = dexaWarnings([row("DEXA lean mass (legs)", 50), row("DEXA lean mass (left leg)", 24), row("DEXA lean mass (right leg)", 25)]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/legs/);
    expect(w[0]).toMatch(/lean mass/);
  });
  it("flags lean + fat + bone that miss the total by more than 1.5 lb", () => {
    expect(dexaWarnings([row("DEXA total mass", 200), row("DEXA lean mass", 150), row("DEXA fat mass", 40), row("DEXA bone mass", 6)])[0]).toMatch(/lean \+ fat \+ bone/);
  });
  it("flags a printed body fat % more than 0.5 away from fat / total", () => {
    const w = dexaWarnings([row("DEXA total mass", 200), row("DEXA fat mass", 50), row("DEXA body fat %", 22, "%")]); // 25% computed
    expect(w[0]).toMatch(/body fat %/);
  });
  it("accepts a printed body fat % on EITHER base: fat / total mass, or fat / (fat + lean) (clinics differ)", () => {
    const base = [row("DEXA total mass", 200), row("DEXA lean mass", 150), row("DEXA fat mass", 40), row("DEXA bone mass", 10)];
    expect(dexaWarnings([...base, row("DEXA body fat %", 20, "%")])).toEqual([]); // 40 / 200
    expect(dexaWarnings([...base, row("DEXA body fat %", 21.1, "%")])).toEqual([]); // 40 / 190
    expect(dexaWarnings([...base, row("DEXA body fat %", 23, "%")])[0]).toMatch(/body fat %/); // neither
  });
  it("converts kg before comparing, and skips a check when an input is missing", () => {
    expect(dexaWarnings([row("DEXA total mass", 90.72, "kg"), row("DEXA lean mass", 68.04, "kg"), row("DEXA fat mass", 20, "kg"), row("DEXA bone mass", 2.7, "kg")])).toEqual([]);
    expect(dexaWarnings([row("DEXA total mass", 200), row("DEXA lean mass", 100)])).toEqual([]);
  });
});
