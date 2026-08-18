/**
 * Client-side Watch metadata access.
 *
 * All requests hit Orbit's own server routes (/api/watch/*) — the TMDB key
 * never leaves the server. Responses are already normalized server-side, and
 * every outcome is an honest discriminated result so the UI can always say
 * exactly what happened ("Search unavailable", "Availability unavailable")
 * instead of guessing.
 */

export interface WatchMovie {
  id: number;
  title: string;
  year: number | null;
  runtime: number | null;
  overview: string | null;
  poster: string | null;
  backdrop: string | null;
}

export interface RegionAvailability {
  /** ISO-3166-1 alpha-2 code, e.g. "IN", "GB". */
  region: string;
  /** The friendly country name the client asked about (for display). */
  country: string;
  /** Provider names (flatrate + rent + buy, deduped). */
  providers: string[];
}

export interface WatchPickResult {
  windowMinutes: number;
  movies: WatchMovie[];
  pick: WatchMovie | null;
  pickReason: 'deterministic' | 'ai' | 'no-fit';
}

export type WatchFailureReason = 'unconfigured' | 'network' | 'invalid';

export type WatchResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: WatchFailureReason };

const REQUEST_TIMEOUT_MS = 8000;

async function getJson<T>(path: string): Promise<WatchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (res.status === 503) return { ok: false, reason: 'unconfigured' };
    if (!res.ok) return { ok: false, reason: 'network' };
    const body = (await res.json()) as unknown;
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

export interface WatchSearchResponse {
  query: string;
  movies: WatchMovie[];
}

export function searchWatch(query: string): Promise<WatchResult<WatchSearchResponse>> {
  return getJson<WatchSearchResponse>(
    `/api/watch/search?q=${encodeURIComponent(query)}`,
  );
}

export function fetchWatchMovie(id: number): Promise<WatchResult<{ movie: WatchMovie }>> {
  return getJson<{ movie: WatchMovie }>(`/api/watch/${id}`);
}

export function fetchWatchAvailability(
  id: number,
  countries: string[],
): Promise<WatchResult<{ movieId: number; regions: RegionAvailability[] }>> {
  return getJson<{ movieId: number; regions: RegionAvailability[] }>(
    `/api/watch/${id}/availability?countries=${encodeURIComponent(countries.join(','))}`,
  );
}

export function pickWatchMovie(
  windowMinutes: number,
  countries: string[],
): Promise<WatchResult<WatchPickResult>> {
  return getJson<WatchPickResult>(
    `/api/watch/pick?windowMinutes=${Math.max(1, Math.round(windowMinutes))}&countries=${encodeURIComponent(countries.join(','))}`,
  );
}

/** Human-readable provider summary for a region entry. */
export function availabilityLabel(region: RegionAvailability | undefined): string {
  if (!region) return 'Availability unavailable';
  if (region.providers.length === 0) return 'Not available';
  return region.providers.slice(0, 3).join(' · ');
}
