import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../server/app.js";

/**
 * Watch route-level tests: the real Fastify app, a real Store on a throwaway
 * DB, and a stubbed global fetch serving deterministic TMDB payloads. These
 * verify the proxy boundary end-to-end — normalized output, honest
 * failures, no key leakage, no raw provider errors.
 */

const TEST_DB = "./data/test_routes_watch.db";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const MOVIE = {
  id: 550,
  title: "Fight Club",
  overview: "An insomniac and a soap salesman.",
  poster_path: "/abc.jpg",
  backdrop_path: null,
  release_date: "1999-10-15",
  runtime: 139,
};

const POPULAR_MOVIES = [
  { id: 1, title: "Short", overview: null, poster_path: null, backdrop_path: null, release_date: "2020-01-01", runtime: 45 },
  { id: 2, title: "Medium", overview: null, poster_path: null, backdrop_path: null, release_date: "2021-01-01", runtime: 90 },
  { id: 3, title: "Long", overview: null, poster_path: null, backdrop_path: null, release_date: "2019-01-01", runtime: 150 },
];

/** URL patterns the route tests may hit upstream. */
type Upstream = "search" | "detail" | "providers" | "popular";

function upstreamKind(url: string): Upstream | null {
  if (url.includes("/search/movie")) return "search";
  if (url.includes("/watch/providers")) return "providers";
  if (url.includes("/movie/popular")) return "popular";
  if (/\/movie\/\d+/.test(url)) return "detail";
  return null;
}

function stubTmdbFetch(opts: { withKey?: boolean } = {}) {
  const urls: string[] = [];
  const mock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (opts.withKey !== false) {
      expect(url).toContain("api_key=route-test-key");
    } else {
      expect(url).toContain("api_key=");
    }
    const kind = upstreamKind(url);
    if (kind === "search") {
      return jsonResponse({ results: [MOVIE] });
    }
    if (kind === "detail") {
      return jsonResponse(MOVIE);
    }
    if (kind === "providers") {
      return jsonResponse({
        results: {
          IN: { flatrate: [{ provider_name: "Netflix" }, { provider_name: "Prime Video" }], rent: [{ provider_name: "Netflix" }] },
          GB: { flatrate: [] },
        },
      });
    }
    if (kind === "popular") {
      return jsonResponse({ results: POPULAR_MOVIES });
    }
    return jsonResponse({ error: "not found" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return urls;
}

describe("watch routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.TMDB_API_KEY = "route-test-key";
    process.env.TMDB_BASE_URL = "https://tmdb.test/3";
    process.env.TMDB_IMAGE_URL = "https://img.tmdb.test/t/p";
    process.env.DATABASE_PATH = TEST_DB;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.TMDB_API_KEY;
    delete process.env.TMDB_BASE_URL;
    delete process.env.TMDB_IMAGE_URL;
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("searches and returns normalized movies — never the raw upstream payload", async () => {
    const urls = stubTmdbFetch();
    const res = await app.inject({ method: "GET", url: "/api/watch/search?q=fight" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.query).toBe("fight");
    expect(body.movies).toEqual([
      {
        id: 550,
        title: "Fight Club",
        year: 1999,
        runtime: 139,
        overview: "An insomniac and a soap salesman.",
        poster: "https://img.tmdb.test/t/p/w342/abc.jpg",
        backdrop: null,
      },
    ]);
    // The API key is server-side: it went upstream, but never comes back down.
    expect(urls[0]).toContain("api_key=route-test-key");
    expect(JSON.stringify(body)).not.toContain("route-test-key");
    expect(JSON.stringify(body)).not.toContain("api_key");
  });

  it("returns 400 for a missing or blank query", async () => {
    const res = await app.inject({ method: "GET", url: "/api/watch/search" });
    expect(res.statusCode).toBe(400);
  });

  it("returns the normalized movie detail with runtime", async () => {
    stubTmdbFetch();
    const res = await app.inject({ method: "GET", url: "/api/watch/550" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.movie).toMatchObject({ id: 550, title: "Fight Club", year: 1999, runtime: 139 });
  });

  it("returns availability only for the requested regions with deduped providers", async () => {
    stubTmdbFetch();
    const res = await app.inject({
      method: "GET",
      url: "/api/watch/550/availability?countries=India,United%20Kingdom",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.movieId).toBe(550);
    expect(body.regions).toEqual([
      { region: "IN", country: "India", providers: ["Netflix", "Prime Video"] },
      { region: "GB", country: "United Kingdom", providers: [] },
    ]);
  });

  it("answers an empty region list for unknown countries without calling upstream", async () => {
    const urls = stubTmdbFetch();
    const res = await app.inject({
      method: "GET",
      url: "/api/watch/550/availability?countries=Atlantis",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, movieId: 550, regions: [] });
    expect(urls).toHaveLength(0);
  });

  it("fails honestly (502) on a malformed upstream response — never raw provider text", async () => {
    const mock = vi.fn(async () => jsonResponse({ results: "not-an-object" }));
    vi.stubGlobal("fetch", mock);
    const res = await app.inject({ method: "GET", url: "/api/watch/550/availability?countries=India" });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("invalid");
    expect(JSON.stringify(body)).not.toContain("not-an-object");
  });

  it("fails honestly (502) on upstream 429/5xx — no provider details leak", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "rate limit exceeded by provider" }, 429)),
    );
    // A query not yet cached forces a real upstream round trip.
    const res = await app.inject({ method: "GET", url: "/api/watch/search?q=interstellar" });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("invalid");
    expect(JSON.stringify(body)).not.toContain("rate limit");
  });

  it("pick-for-us filters deterministically to the shared window before anything else", async () => {
    stubTmdbFetch();
    const res = await app.inject({
      method: "GET",
      url: "/api/watch/pick?windowMinutes=60&countries=India,United%20Kingdom",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.windowMinutes).toBe(60);
    // Only the 45-minute movie fits the 60-minute window.
    expect(body.movies.map((m: { id: number }) => m.id)).toEqual([1]);
    expect(body.pick?.id).toBe(1);
    expect(body.pick?.runtime).toBeLessThanOrEqual(60);
    expect(body.pickReason).toBe("deterministic");
  });

  it("reports no-fit honestly when nothing fits the window", async () => {
    stubTmdbFetch();
    const res = await app.inject({
      method: "GET",
      url: "/api/watch/pick?windowMinutes=30&countries=India,United%20Kingdom",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.movies).toEqual([]);
    expect(body.pick).toBeNull();
    expect(body.pickReason).toBe("no-fit");
  });

  it("rejects an out-of-range windowMinutes", async () => {
    stubTmdbFetch();
    const res = await app.inject({ method: "GET", url: "/api/watch/pick?windowMinutes=0" });
    expect(res.statusCode).toBe(400);
  });
});

describe("watch routes without a TMDB key", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    process.env.TMDB_API_KEY = "";
    process.env.DATABASE_PATH = TEST_DB;
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.TMDB_API_KEY;
    delete process.env.DATABASE_PATH;
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers 503 unconfigured for every watch route without calling upstream", async () => {
    const mock = vi.fn();
    vi.stubGlobal("fetch", mock);
    const search = await app.inject({ method: "GET", url: "/api/watch/search?q=fight" });
    const detail = await app.inject({ method: "GET", url: "/api/watch/550" });
    const avail = await app.inject({ method: "GET", url: "/api/watch/550/availability?countries=India" });
    const pick = await app.inject({ method: "GET", url: "/api/watch/pick?windowMinutes=60" });
    for (const res of [search, detail, avail, pick]) {
      expect(res.statusCode).toBe(503);
      expect(res.json().ok).toBe(false);
      expect(res.json().reason).toBe("unconfigured");
    }
    expect(mock).not.toHaveBeenCalled();
  });
});
