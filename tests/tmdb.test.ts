import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  countryToIso,
  getAvailability,
  getMovie,
  getPopularMovies,
  normalizeMovie,
  searchMovies,
  type TmdbConfig,
} from "../server/tmdb.js";

const CONFIG: TmdbConfig = {
  apiKey: "test-key",
  baseUrl: "https://tmdb.test/3",
  imageUrl: "https://img.tmdb.test/t/p",
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("tmdb service", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("countryToIso", () => {
    it("maps known countries and rejects unknown ones", () => {
      expect(countryToIso("India")).toBe("IN");
      expect(countryToIso("United Kingdom")).toBe("GB");
      expect(countryToIso("United States")).toBe("US");
      expect(countryToIso("  Japan  ")).toBe("JP");
      // Persisted identities may store the ISO code instead of the name.
      expect(countryToIso("GB")).toBe("GB");
      expect(countryToIso("gb")).toBe("GB");
      expect(countryToIso("Atlantis")).toBeNull();
    });
  });

  describe("normalizeMovie", () => {
    it("produces the normalized WatchMovie shape with absolute image URLs", () => {
      const movie = normalizeMovie(
        {
          id: 550,
          title: "Fight Club",
          overview: "An insomniac and a soap salesman.",
          poster_path: "/abc.jpg",
          backdrop_path: "/def.jpg",
          release_date: "1999-10-15",
          runtime: 139,
        },
        CONFIG,
      );
      expect(movie).toEqual({
        id: 550,
        title: "Fight Club",
        year: 1999,
        runtime: 139,
        overview: "An insomniac and a soap salesman.",
        poster: "https://img.tmdb.test/t/p/w342/abc.jpg",
        backdrop: "https://img.tmdb.test/t/p/w780/def.jpg",
      });
    });

    it("nulls unknown fields instead of fabricating them", () => {
      const movie = normalizeMovie({ id: 1, title: "X" }, CONFIG);
      expect(movie.year).toBeNull();
      expect(movie.runtime).toBeNull();
      expect(movie.overview).toBeNull();
      expect(movie.poster).toBeNull();
      expect(movie.backdrop).toBeNull();
    });
  });

  describe("searchMovies", () => {
    it("returns an unconfigured outcome without a key (never a fake result)", async () => {
      const result = await searchMovies("fight", { ...CONFIG, apiKey: "" }, fetchMock);
      expect(result).toEqual({ ok: false, reason: "unconfigured" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("normalizes a valid search response and caps the result count", async () => {
      const results = Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        title: `Movie ${i + 1}`,
        release_date: "2000-01-01",
        overview: null,
        poster_path: null,
        backdrop_path: null,
        runtime: null,
      }));
      fetchMock.mockResolvedValue(jsonResponse({ results }));
      const result = await searchMovies("movie", CONFIG, fetchMock);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.movies).toHaveLength(10);
        expect(result.data.query).toBe("movie");
      }
    });

    it("fails honestly on a malformed upstream response", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ unexpected: true }));
      const result = await searchMovies("fight", CONFIG, fetchMock);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });

    it("fails honestly on a network error", async () => {
      fetchMock.mockRejectedValue(new Error("boom"));
      const result = await searchMovies("fight", CONFIG, fetchMock);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("getMovie", () => {
    it("returns the normalized detail", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ id: 550, title: "Fight Club", release_date: "1999-10-15", runtime: 139, overview: "o" }),
      );
      const result = await getMovie(550, CONFIG, fetchMock);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.title).toBe("Fight Club");
        expect(result.data.year).toBe(1999);
      }
    });
  });

  describe("getAvailability", () => {
    it("returns only requested regions with deduped provider names", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          results: {
            IN: {
              flatrate: [{ provider_name: "Netflix" }, { provider_name: "Prime Video" }],
              rent: [{ provider_name: "Netflix" }],
            },
            GB: { flatrate: [] },
          },
        }),
      );
      const result = await getAvailability(550, ["India", "United Kingdom"], CONFIG, fetchMock);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.regions).toEqual([
          { region: "IN", country: "India", providers: ["Netflix", "Prime Video"] },
          { region: "GB", country: "United Kingdom", providers: [] },
        ]);
      }
    });

    it("omits unknown countries and never fabricates availability", async () => {
      const result = await getAvailability(550, ["Atlantis"], CONFIG, fetchMock);
      expect(result).toEqual({ ok: true, data: { movieId: 550, regions: [] } });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails honestly on a malformed providers payload", async () => {
      fetchMock.mockResolvedValue(jsonResponse({ results: "not-an-object" }));
      const result = await getAvailability(550, ["India"], CONFIG, fetchMock);
      expect(result).toEqual({ ok: false, reason: "invalid" });
    });
  });

  describe("getPopularMovies", () => {
    it("returns the popular pool used by pick-for-us", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          results: [
            { id: 1, title: "A", release_date: "2020-01-01", overview: null, poster_path: null, backdrop_path: null, runtime: 90 },
            { id: 2, title: "B", release_date: "2021-01-01", overview: null, poster_path: null, backdrop_path: null, runtime: 120 },
          ],
        }),
      );
      const result = await getPopularMovies(CONFIG, fetchMock);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toHaveLength(2);
    });
  });
});
