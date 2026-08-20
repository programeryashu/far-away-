import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Play } from 'lucide-react';
import {
  buildMomentFacts,
  getMomentCache,
  localFallbackResponse,
  momentCacheKey,
  requestMomentRecommendation,
  setMomentCache,
  type MomentFacts,
} from '../lib/moment';
import type { CityData } from '../lib/cities';
import type { MomentActivity, MomentResponse } from '../../shared/moment';

/** What the user chose to launch — the existing realtime system executes it. */
export interface MomentLaunch {
  type: MomentActivity;
  durationMin?: number;
}

interface SharedMomentProps {
  cityA: CityData;
  cityB: CityData;
  nameA: string;
  nameB: string;
  /** True when a second peer is connected right now. */
  hasPeer: boolean;
  /** Stable per-session key so the recommendation cache and state reset on leave. */
  sessionKey: string;
  /** Remote session ownership hint sent with the request (null in local mode). */
  session?: { sessionId: string; peerId: string } | null;
  onLaunch: (launch: MomentLaunch) => void;
}

type Status = 'idle' | 'thinking' | 'ready' | 'started';

const ACTIVITY_LABEL: Record<MomentActivity, string> = {
  timer: 'shared focus session',
  cinema: 'shared watch',
  canvas: 'shared canvas',
  chat: 'conversation',
};

const formatMinutes = (total: number): string => {
  const h = Math.floor(total / 60);
  const m = Math.round(total % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

export const SharedMoment: React.FC<SharedMomentProps> = ({
  cityA,
  cityB,
  nameA,
  nameB,
  hasPeer,
  sessionKey,
  session,
  onLaunch,
}) => {
  // Facts tick every 30s so the displayed local times stay honest without a
  // busy per-second re-render.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const facts: MomentFacts | null = useMemo(() => {
    try {
      return buildMomentFacts(cityA, cityB, now);
    } catch {
      return null;
    }
  }, [cityA, cityB, now]);

  const cacheKey = momentCacheKey(sessionKey, cityA, cityB);

  // A cached recommendation for this (session, city pair) renders immediately
  // — the demo's no-second-network-call guarantee. Status is derived: no
  // response yet means we are thinking; `started` is the one explicit flag.
  const [response, setResponse] = useState<MomentResponse | null>(() =>
    getMomentCache(cacheKey),
  );
  const [started, setStarted] = useState(false);

  // Fetch once per (session, city pair). Any failure falls back to the same
  // deterministic rules the server would use. All state updates happen in the
  // promise callbacks — never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    if (getMomentCache(cacheKey)) return; // already served by the initializer
    let built: MomentFacts;
    try {
      built = buildMomentFacts(cityA, cityB, new Date());
    } catch {
      return;
    }
    requestMomentRecommendation(built.context, session)
      .then((res) => {
        if (cancelled) return;
        setMomentCache(cacheKey, res);
        setResponse(res);
      })
      .catch(() => {
        if (cancelled) return;
        setResponse(localFallbackResponse(built.context));
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, cityA, cityB, session]);

  const handleStart = useCallback(() => {
    if (!response || started) return;
    setStarted(true);
    onLaunch({
      type: response.recommendation.activity,
      durationMin: response.recommendation.durationMinutes,
    });
  }, [response, started, onLaunch]);

  const rec = response?.recommendation ?? null;
  const label = rec ? ACTIVITY_LABEL[rec.activity] : null;
  const status: Status = started ? 'started' : response ? 'ready' : 'thinking';

  return (
    <section className="open-section" aria-label="Shared moment">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        <div>
          <h2 className="open-section-title">
            When you're both free
          </h2>
        </div>

        {/* Deterministic facts — instant, exact, no AI involved. */}
        {facts && (
          <div className="shared-moment-facts">
            <div>
              <span className="eyebrow" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {nameA || 'User A'}
              </span>
              <div style={{ fontSize: 'var(--text-label-size)', color: 'var(--text-secondary)', marginTop: '2px' }}>{cityA.name}</div>
              <div className="tabular" style={{ fontSize: '22px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '6px', letterSpacing: '-0.02em' }}>
                {facts.context.participantA.localTime}
              </div>
            </div>

            <div
              style={{
                borderLeft: '1px solid var(--border-glass)',
                borderRight: '1px solid var(--border-glass)',
                textAlign: 'center',
                padding: '0 12px'
              }}
            >
              <span className="eyebrow">
                {facts.context.overlapActive ? 'live window' : facts.hasOverlapToday ? 'next window' : 'overlap'}
              </span>
              <div style={{ fontSize: 'var(--text-subheading-size)', fontWeight: 600, marginTop: '6px' }}>
                {facts.context.bestWindow.label}
              </div>
              <div style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)', marginTop: '2px' }}>
                {formatMinutes(facts.totalOverlapTodayMin)} shared today
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <span className="eyebrow" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {nameB || 'User B'}
              </span>
              <div style={{ fontSize: 'var(--text-label-size)', color: 'var(--text-secondary)', marginTop: '2px' }}>{cityB.name}</div>
              <div className="tabular" style={{ fontSize: '22px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '6px', letterSpacing: '-0.02em' }}>
                {facts.context.participantB.localTime}
              </div>
            </div>
          </div>
        )}

        {/* Recommendation surface — open layout, no card. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)'
          }}
        >
          {status === 'thinking' && (
            <div style={{ fontSize: 'var(--text-label-size)', color: 'var(--text-secondary)' }}>
              Finding your best shared moment…
            </div>
          )}

          {status !== 'thinking' && rec && response && (
            <>
              <div style={{ fontSize: 'var(--text-label-size)', fontWeight: 600, color: 'var(--accent)' }}>
Recommended:{' '}
                <span style={{ color: 'var(--text-primary)' }}>
                  {rec.activity === 'cinema'
                    ? `${rec.durationMinutes}-minute watch`
                    : `${rec.durationMinutes}-minute ${label}`}
                </span>
              </div>
              <div style={{ fontSize: 'var(--text-label-size)', color: 'var(--text-secondary)' }}>
                {rec.explanation}
              </div>
              {rec.activity === 'cinema' && (
                <div style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)' }}>
                  The movie choice is yours — pick something that fits the window, and playback runs on a safe demo clip.
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                <button
                  onClick={handleStart}
                  className="btn btn-primary cta-attention"
                  disabled={started}
                  style={{ gap: '6px', padding: '8px 16px', fontSize: 'var(--text-label-size)' }}
                >
                  <Play size={14} />
                  {rec.activity === 'chat'
                    ? 'Go to Chat'
                    : rec.activity === 'cinema'
                      ? 'Choose a movie'
                      : 'Start Together'}
                </button>
                {started && (
                  <span style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-secondary)' }}>
                    {rec.activity === 'chat'
                      ? 'Opening the conversation…'
                      : hasPeer
                        ? `${label} started — synced to both devices.`
                        : `${label} started on your device.`}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
};
