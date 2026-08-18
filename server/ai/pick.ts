import type { WatchMovie } from "../tmdb.js";

/**
 * Pick-for-us candidate selection — the deterministic core that must always
 * run BEFORE any AI ranking. The AI may only choose among the candidates
 * returned here; it can never invent a title, runtime, provider, or
 * availability. When AI is unavailable, the first candidate (popularity
 * order) is the deterministic pick.
 */
export interface PickOutcome {
  candidates: WatchMovie[];
  pick: WatchMovie | null;
  reason: "deterministic" | "no-fit";
}

export function pickForUs(
  pool: WatchMovie[],
  windowMinutes: number,
  _availableInBoth: Set<number> = new Set(),
): PickOutcome {
  // Runtime must be known and fit the shared window — a movie without a
  // runtime can never be recommended (no fabrication).
  const withRuntime = pool.filter(
    (m): m is WatchMovie & { runtime: number } => m.runtime !== null && m.runtime > 0,
  );
  const candidates = withRuntime.filter((m) => m.runtime <= windowMinutes);

  if (candidates.length === 0) {
    return { candidates: [], pick: null, reason: "no-fit" };
  }

  // Availability is a soft signal: prefer a candidate available in both
  // regions when the data exists, but never drop a candidate without data.
  const preferred = candidates.filter((m) => _availableInBoth.has(m.id));
  const ranked = preferred.length > 0 ? preferred : candidates;

  return { candidates, pick: ranked[0], reason: "deterministic" };
}
