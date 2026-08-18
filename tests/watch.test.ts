import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pickForUs } from "../server/ai/pick.js";

describe("watch pick-for-us (deterministic filtering first)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pool = [
    { id: 1, title: "Short", year: 2020, runtime: 45, overview: null, poster: null, backdrop: null },
    { id: 2, title: "Medium", year: 2021, runtime: 90, overview: null, poster: null, backdrop: null },
    { id: 3, title: "Too Long", year: 2019, runtime: 150, overview: null, poster: null, backdrop: null },
    { id: 4, title: "No Runtime", year: 2018, runtime: null, overview: null, poster: null, backdrop: null },
  ];

  it("keeps only candidates whose runtime fits the shared window", () => {
    const { candidates, pick, reason } = pickForUs(pool, 60, new Set());
    expect(candidates.map((c) => c.id)).toEqual([1]);
    expect(pick?.id).toBe(1);
    expect(reason).toBe("deterministic");
  });

  it("reports no-fit honestly when nothing fits", () => {
    const result = pickForUs(pool, 30, new Set());
    expect(result.candidates).toEqual([]);
    expect(result.pick).toBeNull();
    expect(result.reason).toBe("no-fit");
  });

  it("never picks a candidate without a runtime (no fabrication)", () => {
    const result = pickForUs(pool, 300, new Set());
    expect(result.candidates.map((c) => c.id)).toEqual([1, 2, 3]);
    expect(result.pick).not.toBeNull();
    expect(result.pick!.runtime).not.toBeNull();
  });

  it("prefers candidates available in both regions when data exists", () => {
    const result = pickForUs(pool, 300, new Set([1]));
    expect(result.pick?.id).toBe(1);
  });
});
