import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildMomentFacts,
  clearMomentCache,
  getMomentCache,
  haversineKm,
  momentCacheKey,
  requestMomentRecommendation,
  setMomentCache,
} from './moment';
import { FALLBACK_CITIES } from './cities';
import {
  deterministicRecommendation,
  formatHourLabel,
  type MomentContext,
} from '../../shared/moment';

const sf = FALLBACK_CITIES[0]; // America/Los_Angeles
const tokyo = FALLBACK_CITIES[1]; // Asia/Tokyo
const paris = FALLBACK_CITIES[5]; // Europe/Paris

// 2026-08-16T01:00:00Z → SF 18:00 (UTC-7 DST), Tokyo 10:00 (UTC+9). Both
// awake; the live window in A-local hours is 15:00–23:00 with 5h remaining.
const LIVE_NOW = new Date('2026-08-16T01:00:00Z');

describe('formatHourLabel', () => {
  it('formats fractional A-local hours as 12-hour labels', () => {
    expect(formatHourLabel(20.5)).toBe('8:30 PM');
    expect(formatHourLabel(0)).toBe('12:00 AM');
    expect(formatHourLabel(12)).toBe('12:00 PM');
    expect(formatHourLabel(9.25)).toBe('9:15 AM');
    expect(formatHourLabel(23.75)).toBe('11:45 PM');
    expect(formatHourLabel(24)).toBe('12:00 AM'); // exclusive window end
  });
});

describe('haversineKm', () => {
  it('computes the same order of magnitude as the UI distance', () => {
    const d = haversineKm(sf.lat, sf.lng, tokyo.lat, tokyo.lng);
    expect(d).toBeGreaterThan(8000);
    expect(d).toBeLessThan(9000);
  });
});

describe('buildMomentFacts', () => {
  it('builds a validated context with exact local times and the live window', () => {
    const facts = buildMomentFacts(sf, tokyo, LIVE_NOW);
    expect(facts.context.participantA).toMatchObject({
      city: 'San Francisco',
      timezone: 'America/Los_Angeles',
      localTime: '6:00 PM',
      hour: 18,
    });
    expect(facts.context.participantB).toMatchObject({
      city: 'Tokyo',
      timezone: 'Asia/Tokyo',
      localTime: '10:00 AM',
      hour: 10,
    });
    // Live window is 15:00–23:00 A-local; 5h remaining at 18:00.
    expect(facts.context.overlapActive).toBe(true);
    expect(facts.context.bestWindow).toEqual({
      label: '3:00 PM — 11:00 PM',
      minutes: 300,
    });
    expect(facts.totalOverlapTodayMin).toBe(480);
    expect(facts.hasOverlapToday).toBe(true);
    expect(facts.context.distanceKm).toBeGreaterThan(8000);
    // Everything the server sees is allowed.
    expect(facts.context.availableActivities).toContain('timer');
  });

  it('picks the next window when there is no live overlap', () => {
    // 2026-08-16T06:00:00Z → SF 23:00 (asleep), Tokyo 15:00 (awake).
    const facts = buildMomentFacts(sf, tokyo, new Date('2026-08-16T06:00:00Z'));
    expect(facts.context.overlapActive).toBe(false);
    // The next live block is 15:00–23:00 A-local (8h, full length).
    expect(facts.context.bestWindow.minutes).toBe(480);
  });
});

describe('deterministicRecommendation', () => {
  const base: MomentContext = {
    participantA: { city: 'A', timezone: 'T', localTime: '6:00 PM', hour: 18 },
    participantB: { city: 'B', timezone: 'T', localTime: '10:00 AM', hour: 10 },
    bestWindow: { label: '3:00 PM — 11:00 PM', minutes: 300 },
    overlapActive: true,
    distanceKm: 8267,
    availableActivities: ['timer', 'cinema', 'canvas', 'chat'],
  };

  it('recommends watching together when far apart with a solid live window', () => {
    const rec = deterministicRecommendation(base);
    expect(rec.activity).toBe('cinema');
    expect(rec.durationMinutes).toBe(45);
    expect(rec.title.length).toBeGreaterThan(0);
  });

  it('recommends a 45-minute focus session when close with a solid window', () => {
    const rec = deterministicRecommendation({ ...base, distanceKm: 500 });
    expect(rec.activity).toBe('timer');
    expect(rec.durationMinutes).toBe(45);
  });

  it('recommends a quick sprint for a medium window', () => {
    const rec = deterministicRecommendation({
      ...base,
      distanceKm: 500,
      bestWindow: { ...base.bestWindow, minutes: 45 },
    });
    expect(rec.activity).toBe('timer');
    expect(rec.durationMinutes).toBe(25);
  });

  it('recommends a light conversation for a short window', () => {
    const rec = deterministicRecommendation({
      ...base,
      distanceKm: 500,
      bestWindow: { ...base.bestWindow, minutes: 15 },
    });
    expect(rec.activity).toBe('chat');
  });

  it('bridges the gap with a message when there is no live overlap', () => {
    const rec = deterministicRecommendation({ ...base, overlapActive: false });
    expect(rec.activity).toBe('chat');
    expect(rec.explanation).toContain('overlap');
  });
});

describe('requestMomentRecommendation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const facts = buildMomentFacts(sf, tokyo, LIVE_NOW);

  it('validates a well-formed server response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            source: 'deterministic',
            recommendation: {
              activity: 'timer',
              durationMinutes: 45,
              title: 'Focus together',
              explanation: 'x',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const res = await requestMomentRecommendation(facts.context);
    expect(res.source).toBe('deterministic');
    expect(res.recommendation.activity).toBe('timer');
  });

  it('rejects a malformed response instead of trusting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ source: 'ai', recommendation: { activity: 'dance' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(requestMomentRecommendation(facts.context)).rejects.toThrow(
      'invalid recommendation response',
    );
  });

  it('rejects when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
    await expect(requestMomentRecommendation(facts.context)).rejects.toThrow(
      'cannot reach the recommendation service',
    );
  });

  it('times out a hung request so the UI can fall back instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      // A fetch that would hang forever — but honors the abort signal.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: { signal?: AbortSignal }) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              );
            }),
        ),
      );
      const pending = requestMomentRecommendation(facts.context);
      // Nothing settles before the timeout…
      const early = await Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')]);
      expect(early).toBe('pending');
      // …and the abort fires at the deadline.
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(pending).rejects.toThrow('cannot reach the recommendation service');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('recommendation cache', () => {
  beforeEach(() => clearMomentCache());

  it('stores and retrieves per (session, city pair) and clears', () => {
    const response = {
      source: 'deterministic' as const,
      recommendation: {
        activity: 'timer' as const,
        durationMinutes: 45,
        title: 'Focus together',
        explanation: 'x',
      },
    };
    const key = momentCacheKey('s1', sf, tokyo);
    expect(getMomentCache(key)).toBeNull();
    setMomentCache(key, response);
    expect(getMomentCache(key)).toEqual(response);
    // A different city pair is a different cache entry.
    expect(getMomentCache(momentCacheKey('s1', sf, paris))).toBeNull();
    clearMomentCache();
    expect(getMomentCache(key)).toBeNull();
  });
});
