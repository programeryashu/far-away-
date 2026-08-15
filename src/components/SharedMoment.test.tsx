// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { SharedMoment } from './SharedMoment';
import { FALLBACK_CITIES } from '../lib/cities';
import { clearMomentCache } from '../lib/moment';

const momentApi = vi.hoisted(() => ({
  requestMomentRecommendation: vi.fn(),
}));

vi.mock('../lib/moment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/moment')>();
  return { ...actual, requestMomentRecommendation: momentApi.requestMomentRecommendation };
});

const sf = FALLBACK_CITIES[0]; // San Francisco
const tokyo = FALLBACK_CITIES[1]; // Tokyo

// 2026-08-16T01:00:00Z → SF 18:00, Tokyo 10:00, live window 15:00–23:00.
const FIXED_NOW = new Date('2026-08-16T01:00:00Z');

const deterministicResponse = {
  source: 'deterministic' as const,
  recommendation: {
    activity: 'cinema' as const,
    durationMinutes: 45,
    title: 'Watch together',
    explanation: 'A world apart — watch side by side.',
  },
};

const renderMoment = (overrides: Partial<Parameters<typeof SharedMoment>[0]> = {}) => {
  const onLaunch = vi.fn();
  const utils = render(
    <SharedMoment
      cityA={sf}
      cityB={tokyo}
      nameA="Yash"
      nameB="Kimi"
      hasPeer={false}
      sessionKey="local"
      session={null}
      onLaunch={onLaunch}
      {...overrides}
    />,
  );
  return { onLaunch, ...utils };
};

describe('SharedMoment', () => {
  beforeEach(() => {
    clearMomentCache();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    // Default: a pending request (nothing resolves) — tests that care override.
    momentApi.requestMomentRecommendation.mockImplementation(
      () => new Promise<never>(() => {}),
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    momentApi.requestMomentRecommendation.mockReset();
  });

  it('shows the deterministic facts instantly, before any recommendation', () => {
    renderMoment();
    // Local times, the live window, and today's overlap are pure client math.
    expect(screen.getByText('6:00 PM')).toBeTruthy();
    expect(screen.getByText('10:00 AM')).toBeTruthy();
    expect(screen.getByText('3:00 PM — 11:00 PM')).toBeTruthy();
    expect(screen.getByText('8h shared today')).toBeTruthy();
  });

  it('shows the validated recommendation and launches Start Together', async () => {
    momentApi.requestMomentRecommendation.mockResolvedValue(deterministicResponse);
    const { onLaunch } = renderMoment();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(/45-minute shared watch/)).toBeTruthy();
    expect(screen.getByText(/A world apart — watch side by side/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /start together/i }));
    expect(onLaunch).toHaveBeenCalledWith({ type: 'cinema', durationMin: 45 });
    // A started recommendation cannot be launched twice.
    expect(
      (screen.getByRole('button', { name: /start together/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('falls back to the deterministic recommendation when the server is unreachable', async () => {
    momentApi.requestMomentRecommendation.mockRejectedValue(new Error('down'));
    const { onLaunch } = renderMoment();
    await act(async () => {
      await Promise.resolve();
    });

    // Same rules as the server: far apart + live overlap → cinema 45.
    expect(screen.getByText(/45-minute shared watch/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /start together/i }));
    expect(onLaunch).toHaveBeenCalledWith({ type: 'cinema', durationMin: 45 });
  });

  it('caches the recommendation per session so re-entry does not refetch', async () => {
    momentApi.requestMomentRecommendation.mockResolvedValue(deterministicResponse);
    const first = renderMoment({ sessionKey: 's1' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(momentApi.requestMomentRecommendation).toHaveBeenCalledTimes(1);

    first.unmount();
    renderMoment({ sessionKey: 's1' });
    await act(async () => {
      await Promise.resolve();
    });
    // Second mount served from cache — no second network round-trip.
    expect(momentApi.requestMomentRecommendation).toHaveBeenCalledTimes(1);

    // A different session re-fetches.
    renderMoment({ sessionKey: 's2' });
    await act(async () => {
      await Promise.resolve();
    });
    expect(momentApi.requestMomentRecommendation).toHaveBeenCalledTimes(2);
  });
});
