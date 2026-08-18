// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  searchWatch,
  fetchWatchMovie,
  fetchWatchAvailability,
  pickWatchMovie,
  availabilityLabel,
} from './watch';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('watch client lib', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes a search result into typed WatchMovie data', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/api/watch/search?q=fight');
      return jsonResponse({
        ok: true,
        query: 'fight',
        movies: [{ id: 550, title: 'Fight Club', year: 1999, runtime: 139, overview: 'o', poster: null, backdrop: null }],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchWatch('fight');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.movies[0].title).toBe('Fight Club');
    }
  });

  it('reports unconfigured (503) honestly — never a fake result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 503)));
    const result = await searchWatch('fight');
    expect(result).toEqual({ ok: false, reason: 'unconfigured' });
  });

  it('reports network failure honestly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)));
    const result = await searchWatch('fight');
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('sends only the two countries for availability (no extra data)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/api/watch/550/availability?countries=');
      expect(decodeURIComponent(url)).toContain('India,Japan');
      return jsonResponse({
        ok: true,
        movieId: 550,
        regions: [
          { region: 'IN', country: 'India', providers: ['Netflix'] },
          { region: 'JP', country: 'Japan', providers: [] },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchWatchAvailability(550, ['India', 'Japan']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.regions).toHaveLength(2);
  });

  it('pick passes the shared window and countries to the server', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain('/api/watch/pick?windowMinutes=45&countries=');
      return jsonResponse({
        ok: true,
        windowMinutes: 45,
        movies: [],
        pick: null,
        pickReason: 'no-fit',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await pickWatchMovie(45, ['India', 'Japan']);
    expect(result.ok).toBe(true);
  });

  it('fetchWatchMovie returns the detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ ok: true, movie: { id: 550, title: 'Fight Club', year: 1999, runtime: 139, overview: null, poster: null, backdrop: null } }),
      ),
    );
    const result = await fetchWatchMovie(550);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.movie.title).toBe('Fight Club');
  });

  it('availabilityLabel is honest for every region state', () => {
    expect(availabilityLabel(undefined)).toBe('Availability unavailable');
    expect(availabilityLabel({ region: 'IN', country: 'India', providers: [] })).toBe('Not available');
    expect(availabilityLabel({ region: 'IN', country: 'India', providers: ['Netflix', 'Prime Video'] })).toBe(
      'Netflix · Prime Video',
    );
  });
});
