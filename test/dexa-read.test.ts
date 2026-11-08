import { describe, it, expect } from "vitest";
import { dexaBlock, type DexaScan } from "@/core/labs/dexaRead";
import { lbToKg } from "@/core/units";

// Synthetic numbers only: nothing here is a real scan.
const scan = (date: string, clinic: string, v: Record<string, number>): DexaScan => ({
  date, clinic, values: new Map(Object.entries(v).map(([k, value]) => [`DEXA ${k}`, { value, unit: k.includes("%") || k.includes("ratio") ? (k.includes("%") ? "%" : null) : "lb" }])),
});
const A = scan("2031-01-05", "Clinic A", {
  "total mass": 200, "lean mass": 150, "fat mass": 44, "bone mass": 6, "body fat %": 22, "visceral fat mass": 1, "android/gynoid ratio": 0.9,
  "lean mass (left arm)": 12, "lean mass (right arm)": 12.6, "total mass (arms)": 30, "fat mass (arms)": 3,
  "lean mass (left leg)": 26, "lean mass (right leg)": 26,
  "total mass (android)": 12, "fat mass (android)": 3, "region fat % (gynoid)": 20.5,
});
const B = scan("2031-09-10", "Clinic B", {
  "total mass": 210, "lean mass": 151, "fat mass": 52.6, "bone mass": 6.4, "body fat %": 25, "visceral fat mass": 1.4,
  "lean mass (left arm)": 12.3, "lean mass (right arm)": 11.9,
});
const reading = (day: string, kg: number, fat: number | null, lean: number | null) => ({ day, at: new Date(`${day}T16:00:00Z`), kg, fat, lean, bmi: null });

describe("dexaBlock", () => {
  it("is null with a short note when there are no scans", () => {
    expect(dexaBlock([], [], "lb")).toMatchObject({ latest: null, note: expect.stringMatching(/No DEXA/) });
  });

  it("shows the latest scan and, with one scan, no change section", () => {
    const b: any = dexaBlock([A], [], "lb");
    expect(b.latest).toMatchObject({ date: "2031-01-05", clinic: "Clinic A", weight: 200, body_fat_pct: 22, lean_mass: 150, fat_mass: 44, bone_mass: 6, scans_on_file: 1 });
    expect(b.change_since_previous).toBeUndefined();
  });

  it("change since the previous scan, with the different-clinic caution", () => {
    const b: any = dexaBlock([A, B], [], "lb");
    expect(b.latest).toMatchObject({ date: "2031-09-10", clinic: "Clinic B", scans_on_file: 2 });
    expect(b.change_since_previous).toMatchObject({ previous_date: "2031-01-05", previous_clinic: "Clinic A", weight: 10, body_fat_pct: 3, lean_mass: 1, fat_mass: 8.6, visceral_fat_mass: 0.4 });
    expect(b.change_since_previous.note).toMatch(/different clinics[\s\S]*1 point of body fat[\s\S]*2 lb of lean mass/i);
    const same: any = dexaBlock([A, { ...B, clinic: "Clinic A" }], [], "lb");
    expect(same.change_since_previous.note).toBeUndefined();
  });

  it("body fat % is compared on ONE base (fat / total mass, the usual basis), whatever each clinic printed", () => {
    // Clinic T prints fat / (fat + lean) = 40 / 190 = 21.1 %; on the standard base it is 40 / 200 = 20.0 %.
    const T = scan("2031-01-05", "Clinic T", { "total mass": 200, "lean mass": 150, "fat mass": 40, "body fat %": 21.1 });
    const S = scan("2031-09-10", "Clinic S", { "total mass": 210, "lean mass": 150, "fat mass": 52.5, "body fat %": 25 }); // 52.5 / 210
    const b: any = dexaBlock([T, S], [], "lb");
    expect(b.latest).toMatchObject({ body_fat_pct: 25, body_fat_pct_printed: 25 });
    expect(b.change_since_previous.body_fat_pct).toBe(5); // 25 - 20.0, not 25 - 21.1
    expect(b.change_since_previous.note).toMatch(/total mass/);
    const t: any = dexaBlock([T], [], "lb");
    expect(t.latest).toMatchObject({ body_fat_pct: 20, body_fat_pct_printed: 21.1 });
    expect(t.note).toMatch(/fat mass ÷ total mass/);
  });

  it("converts to the user's units (a scan stored in kg reads back in lb, and the reverse)", () => {
    const kg = scan("2031-01-05", "Clinic A", {});
    kg.values.set("DEXA total mass", { value: 90.7184, unit: "kg" });
    expect((dexaBlock([kg], [], "lb") as any).latest.weight).toBe(200);
    expect((dexaBlock([A], [], "kg") as any).latest.weight).toBe(90.7);
  });

  it("scale vs DEXA: the nearest weigh-in within 3 days; scale lean is fat-free mass, so it is compared with DEXA lean + bone", () => {
    const scale = [reading("2031-09-06", 90, 30, 60), reading("2031-09-09", lbToKg(209.4), 24, 69), reading("2031-09-12", 96, 23, 70)];
    const b: any = dexaBlock([A, B], scale, "lb");
    const s = b.scale_vs_dexa;
    expect(s).toMatchObject({ scale_date: "2031-09-09", days_apart: 1 });
    expect(s.weight).toMatchObject({ scale: 209.4, dexa: 210, difference: -0.6 });
    expect(s.body_fat_pct).toMatchObject({ scale: 24, dexa: 25, difference: -1 });
    expect(s.fat_free_mass).toMatchObject({ dexa_lean_plus_bone: 157.4 }); // 151 + 6.4
    expect(s.fat_free_mass.scale_lean_mass).toBeCloseTo(152.1, 1); // 69 kg
    expect(s.fat_free_mass.difference).toBeCloseTo(-5.3, 1);
    expect(s.note).toMatch(/not adjusted/);
  });

  it("no scale reading within 3 days: scale_vs_dexa is null with a note; a tie picks the earlier day", () => {
    const far: any = dexaBlock([A, B], [reading("2031-09-14", 95, 24, 69)], "lb");
    expect(far.scale_vs_dexa).toBeNull();
    expect(far.scale_vs_dexa_note).toMatch(/within 3 days/);
    const tie: any = dexaBlock([A, B], [reading("2031-09-12", 95, 24, 69), reading("2031-09-08", 94, 24, 69)], "lb");
    expect(tie.scale_vs_dexa).toMatchObject({ scale_date: "2031-09-08", days_apart: 2 });
  });

  it("left vs right lean mass as a % difference (derived), and region fat % printed or derived", () => {
    const b: any = dexaBlock([A], [], "lb");
    expect(b.left_vs_right.arms).toMatchObject({ left_lean: 12, right_lean: 12.6, difference_pct: 4.9, higher: "right", derived: true }); // 0.6 / 12.3
    expect(b.left_vs_right.legs).toMatchObject({ difference_pct: 0, higher: "equal" });
    expect(b.left_vs_right.trunk).toBeUndefined(); // not on this report
    const fat = Object.fromEntries(b.region_fat_pct.map((r: any) => [r.region, r]));
    expect(fat.arms).toMatchObject({ fat_pct: 10, derived: true }); // 3 / 30
    expect(fat.android).toMatchObject({ fat_pct: 25, derived: true }); // 3 / 12
    expect(fat.gynoid).toMatchObject({ fat_pct: 20.5 }); // printed
    expect(fat.gynoid.derived).toBeUndefined();
  });

  it("scans are ordered by date whatever order they arrive in", () => {
    expect((dexaBlock([B, A], [], "lb") as any).latest.date).toBe("2031-09-10");
  });
});
