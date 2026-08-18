import { z } from "zod";

/**
 * Watch metadata service (TMDB proxy boundary).
 *
 * The API key stays in the server env and never reaches the browser. Every
 * upstream response is strictly validated with Zod BEFORE any field is used,
 * and the client only ever receives the normalized `WatchMovie` /
 * `RegionAvailability` shapes below — never the raw TMDB payload.
 *
 * Availability is informational: Orbit discovers titles and checks where they
 * are watchable, but never streams or hosts them.
 */

export interface TmdbConfig {
  apiKey: string;
  baseUrl: string;
  imageUrl: string;
}

/** Injectable fetch for tests; defaults to the Node global. */
export type TmdbFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WatchMovie {
  id: number;
  title: string;
  /** Release year (null when unknown). */
  year: number | null;
  /** Runtime in minutes (null for search results until the detail is fetched). */
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

export type WatchErrorReason = "unconfigured" | "network" | "invalid";

export type WatchOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; reason: WatchErrorReason };

const FETCH_TIMEOUT_MS = 6000;

// ---------------------------------------------------------------------------
// Upstream Zod schemas — a TMDB change or hostile payload fails loudly here.
// ---------------------------------------------------------------------------
const TmdbMovieSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  overview: z.string().nullable().optional(),
  poster_path: z.string().nullable().optional(),
  backdrop_path: z.string().nullable().optional(),
  release_date: z.string().nullable().optional(),
  runtime: z.number().int().nonnegative().nullable().optional(),
});

const TmdbSearchSchema = z.object({
  results: z.array(TmdbMovieSchema),
});

const TmdbProvidersSchema = z.object({
  results: z
    .record(
      z.string(),
      z.object({
        flatrate: z.array(z.object({ provider_name: z.string() })).optional(),
        rent: z.array(z.object({ provider_name: z.string() })).optional(),
        buy: z.array(z.object({ provider_name: z.string() })).optional(),
      }),
    )
    .optional(),
});

// ---------------------------------------------------------------------------
// Country → ISO-3166-1 alpha-2 (TMDB regions). Unknown countries are skipped,
// and the UI reports "Availability unavailable" — never a guess.
// ---------------------------------------------------------------------------
const COUNTRY_ISO: Record<string, string> = {
  "United States": "US",
  "United Kingdom": "GB",
  India: "IN",
  Japan: "JP",
  Australia: "AU",
  France: "FR",
  Germany: "DE",
  Egypt: "EG",
  Brazil: "BR",
  "South Africa": "ZA",
  Canada: "CA",
  Singapore: "SG",
  "United Arab Emirates": "AE",
  Netherlands: "NL",
  Spain: "ES",
  Italy: "IT",
  Mexico: "MX",
  Russia: "RU",
  "South Korea": "KR",
  China: "CN",
  Indonesia: "ID",
  "New Zealand": "NZ",
  Sweden: "SE",
  Norway: "NO",
  Denmark: "DK",
  Finland: "FI",
  Switzerland: "CH",
  Austria: "AT",
  Belgium: "BE",
  Ireland: "IE",
  Poland: "PL",
  Turkey: "TR",
  "Saudi Arabia": "SA",
  Israel: "IL",
  Argentina: "AR",
  Chile: "CL",
  Colombia: "CO",
};

export function countryToIso(countryName: string): string | null {
  const trimmed = countryName.trim();
  // Accept a name ("United Kingdom") OR an already-normalized ISO code
  // ("GB", "gb") — identities may persist either form.
  if (/^[a-z]{2}$/i.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_ISO[trimmed] ?? null;
}

function yearFromReleaseDate(releaseDate: string | null | undefined): number | null {
  if (!releaseDate) return null;
  const m = /^(\d{4})/.exec(releaseDate);
  return m ? Number(m[1]) : null;
}

function imageUrl(config: TmdbConfig, path: string | null | undefined, size: string): string | null {
  if (!path) return null;
  return `${config.imageUrl}/${size}${path}`;
}

export function normalizeMovie(raw: z.infer<typeof TmdbMovieSchema>, config: TmdbConfig): WatchMovie {
  return {
    id: raw.id,
    title: raw.title,
    year: yearFromReleaseDate(raw.release_date),
    runtime: raw.runtime ?? null,
    overview: raw.overview?.trim() ? raw.overview : null,
    poster: imageUrl(config, raw.poster_path, "w342"),
    backdrop: imageUrl(config, raw.backdrop_path, "w780"),
  };
}

// ---------------------------------------------------------------------------
// Small in-memory cache (TTL) — TMDB calls are rate-limited, and the demo
// must not hammer the upstream. Keyed by the full request URL.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS: Record<string, number> = {
  search: 10 * 60_000,
  detail: 60 * 60_000,
  availability: 30 * 60_000,
  popular: 10 * 60_000,
};

const cache = new Map<string, { kind: string; at: number; value: unknown }>();

function cached<T>(key: string, kind: string): T | undefined {
  const hit = cache.get(key);
  if (!hit || hit.kind !== kind) return undefined;
  if (Date.now() - hit.at > (CACHE_TTL_MS[kind] ?? 0)) {
    cache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function remember(key: string, kind: string, value: unknown) {
  cache.set(key, { kind, at: Date.now(), value });
}

async function fetchJson(
  url: string,
  fetchImpl: TmdbFetch,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`upstream status ${res.status}`);
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function tmdbUrl(config: TmdbConfig, path: string): string {
  return `${config.baseUrl}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(config.apiKey)}&language=en-US`;
}

function configured(config: TmdbConfig): boolean {
  return config.apiKey.length > 0;
}

export async function searchMovies(
  query: string,
  config: TmdbConfig,
  fetchImpl: TmdbFetch = fetch,
): Promise<WatchOutcome<{ query: string; movies: WatchMovie[] }>> {
  if (!configured(config)) return { ok: false, reason: "unconfigured" };
  const url = tmdbUrl(config, `/search/movie?query=${encodeURIComponent(query)}`);
  const key = `search:${query.trim().toLowerCase()}`;
  const hit = cached<{ query: string; movies: WatchMovie[] }>(key, "search");
  if (hit) return { ok: true, data: hit };
  try {
    const raw = await fetchJson(url, fetchImpl);
    const parsed = TmdbSearchSchema.parse(raw);
    const movies = parsed.results.slice(0, 10).map((m) => normalizeMovie(m, config));
    const data = { query, movies };
    remember(key, "search", data);
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export async function getMovie(
  id: number,
  config: TmdbConfig,
  fetchImpl: TmdbFetch = fetch,
): Promise<WatchOutcome<WatchMovie>> {
  if (!configured(config)) return { ok: false, reason: "unconfigured" };
  const key = `detail:${id}`;
  const hit = cached<WatchMovie>(key, "detail");
  if (hit) return { ok: true, data: hit };
  try {
    const raw = await fetchJson(tmdbUrl(config, `/movie/${id}`), fetchImpl);
    const parsed = TmdbMovieSchema.parse(raw);
    const movie = normalizeMovie(parsed, config);
    remember(key, "detail", movie);
    return { ok: true, data: movie };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Provider availability for the requested countries. Only the requested
 * regions are returned, and only provider NAMES (never tokens/links the UI
 * has no use for). Unknown countries are omitted — the client reports
 * "Availability unavailable" for them.
 */
export async function getAvailability(
  id: number,
  countries: string[],
  config: TmdbConfig,
  fetchImpl: TmdbFetch = fetch,
): Promise<WatchOutcome<{ movieId: number; regions: RegionAvailability[] }>> {
  if (!configured(config)) return { ok: false, reason: "unconfigured" };
  const requested = [...new Set(countries.map((c) => c.trim()).filter(Boolean))].slice(0, 4);
  const isos = requested
    .map((c) => ({ country: c, iso: countryToIso(c) }))
    .filter((x): x is { country: string; iso: string } => x.iso !== null);
  if (isos.length === 0) return { ok: true, data: { movieId: id, regions: [] } };
  const key = `availability:${id}:${isos.map((x) => x.iso).sort().join(",")}`;
  const hit = cached<{ movieId: number; regions: RegionAvailability[] }>(key, "availability");
  if (hit) return { ok: true, data: hit };
  try {
    const raw = await fetchJson(tmdbUrl(config, `/movie/${id}/watch/providers`), fetchImpl);
    const parsed = TmdbProvidersSchema.parse(raw);
    const results = parsed.results ?? {};
    const regions: RegionAvailability[] = [];
    for (const { country, iso } of isos) {
      const entry = results[iso];
      if (!entry) continue;
      const providers = [
        ...(entry.flatrate ?? []),
        ...(entry.rent ?? []),
        ...(entry.buy ?? []),
      ]
        .map((p) => p.provider_name)
        .filter((name, i, arr) => name && arr.indexOf(name) === i)
        .slice(0, 8);
      regions.push({ region: iso, country, providers });
    }
    const data = { movieId: id, regions };
    remember(key, "availability", data);
    return { ok: true, data };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/** Popular movies — the candidate pool for "Pick something for us". */
export async function getPopularMovies(
  config: TmdbConfig,
  fetchImpl: TmdbFetch = fetch,
): Promise<WatchOutcome<WatchMovie[]>> {
  if (!configured(config)) return { ok: false, reason: "unconfigured" };
  const key = "popular:1";
  const hit = cached<WatchMovie[]>(key, "popular");
  if (hit) return { ok: true, data: hit };
  try {
    const raw = await fetchJson(tmdbUrl(config, "/movie/popular"), fetchImpl);
    const parsed = TmdbSearchSchema.parse(raw);
    const movies = parsed.results.map((m) => normalizeMovie(m, config));
    remember(key, "popular", movies);
    return { ok: true, data: movies };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
