import {
  deterministicRecommendation,
  formatHourLabel,
  MOMENT_ACTIVITIES,
  MomentContextSchema,
  MomentResponseSchema,
  type MomentActivity,
  type MomentContext,
  type MomentResponse,
} from '../../shared/moment';
import { computeLiveWindow, getUTCOffsetHours } from './time';
import type { CityData } from './cities';

/**
 * Client side of Shared Moment.
 *
 * Deterministic facts (local times, overlap window, distance) are computed
 * here — exact JavaScript math, never an LLM. The context object is what gets
 * sent to the server for the recommendation, and the response is strictly
 * validated before the UI may trust it. Offline (or server unreachable) the
 * same shared deterministic rules produce the recommendation.
 */

const API_URL = '/api/shared-moment/recommend';

/** Great-circle distance in km (haversine) — the same math the UI shows. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatLocalTime(timezone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(now);
  } catch {
    return now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }
}

function localHour(timezone: string, now: Date): number {
  const offset = getUTCOffsetHours(timezone, now);
  return ((now.getUTCHours() + now.getUTCMinutes() / 60 + offset) % 24 + 24) % 24;
}

export interface MomentFacts {
  context: MomentContext;
  /** Total overlap today in minutes (all live blocks). */
  totalOverlapTodayMin: number;
  /** True when there is any overlap block today. */
  hasOverlapToday: boolean;
}

/**
 * Build the deterministic facts + AI context for two people right now. The
 * best window is the live block when one is open, otherwise the next block —
 * "minutes" is remaining when live, full length when next.
 */
export function buildMomentFacts(
  cityA: CityData,
  cityB: CityData,
  now: Date,
  availableActivities: MomentActivity[] = [...MOMENT_ACTIVITIES],
): MomentFacts {
  const win = computeLiveWindow(cityA.timezone, cityB.timezone, now);
  const nowLocalA = localHour(cityA.timezone, now);

  let overlapActive = false;
  let start = 0;
  let end = 0;
  let minutes = 0;

  if (win.intervals.length > 0) {
    const current = win.intervals.find(
      (iv) => nowLocalA >= iv.start && nowLocalA < iv.end,
    );
    if (current) {
      overlapActive = true;
      start = current.start;
      end = current.end;
      minutes = Math.max(0, Math.round((end - nowLocalA) * 60));
    } else {
      const next = win.intervals.find((iv) => iv.start > nowLocalA) ?? win.intervals[0];
      start = next.start;
      end = next.end;
      minutes = Math.round((end - start) * 60);
    }
  }

  const label =
    win.intervals.length === 0
      ? 'No overlap today'
      : `${formatHourLabel(start)} — ${formatHourLabel(end)}`;

  const context: MomentContext = {
    participantA: {
      city: cityA.name,
      timezone: cityA.timezone,
      localTime: formatLocalTime(cityA.timezone, now),
      hour: nowLocalA,
    },
    participantB: {
      city: cityB.name,
      timezone: cityB.timezone,
      localTime: formatLocalTime(cityB.timezone, now),
      hour: localHour(cityB.timezone, now),
    },
    bestWindow: { label, minutes },
    overlapActive,
    distanceKm: Math.round(
      haversineKm(cityA.lat, cityA.lng, cityB.lat, cityB.lng),
    ),
    availableActivities,
  };

  // The context is validated before it ever leaves the client.
  const parsed = MomentContextSchema.safeParse(context);
  if (!parsed.success) throw new Error('built an invalid moment context');

  return {
    context: parsed.data,
    totalOverlapTodayMin: Math.round(win.totalHours * 60),
    hasOverlapToday: win.intervals.length > 0,
  };
}

/**
 * Ask the server for a recommendation. The response is validated against the
 * shared schema — malformed output fails loudly so the caller can fall back.
 */
export async function requestMomentRecommendation(
  context: MomentContext,
  session?: { sessionId: string; peerId: string } | null,
): Promise<MomentResponse> {
  let res: Response;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...context, ...(session ?? {}) }),
    });
  } catch {
    throw new Error('cannot reach the recommendation service');
  }
  if (!res.ok) throw new Error(`recommendation request failed (${res.status})`);
  const body: unknown = await res.json();
  const parsed = MomentResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('invalid recommendation response');
  return parsed.data;
}

/** The offline/skeleton response — identical rules to the server's fallback. */
export function localFallbackResponse(context: MomentContext): MomentResponse {
  return {
    source: 'deterministic',
    recommendation: deterministicRecommendation(context),
  };
}

// ---- per-session recommendation cache ----
// Keyed by session + the two cities. A recommendation is advisory and stable
// within a session, so the demo never depends on a second network round-trip.

const cache = new Map<string, MomentResponse>();

export function momentCacheKey(
  sessionKey: string,
  cityA: CityData,
  cityB: CityData,
): string {
  return [
    sessionKey,
    cityA.name,
    cityB.name,
    cityA.timezone,
    cityB.timezone,
  ].join('|');
}

export function getMomentCache(key: string): MomentResponse | null {
  return cache.get(key) ?? null;
}

export function setMomentCache(key: string, response: MomentResponse): void {
  cache.set(key, response);
}

export function clearMomentCache(): void {
  cache.clear();
}
