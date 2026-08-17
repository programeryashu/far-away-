import React, { useEffect, useState } from 'react';
import { haversineKm } from '../lib/geo';
import { computeLiveWindow, formatClock } from '../lib/time';

interface LiveWindowProps {
  cityA: { name: string; lat: number; lng: number; timezone: string };
  cityB: { name: string; lat: number; lng: number; timezone: string };
  nameA: string;
  nameB: string;
  hasPeer: boolean;
  /** This client's session role — marks which side is "you". Null in local mode. */
  role?: 'a' | 'b' | null;
}

const formatHours = (hours: number): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
};

const localTime = (date: Date, timeZone: string): string => {
  try {
    return date.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  } catch {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
};

/**
 * The shared-time signature — Orbit's centerpiece. Two people, two clocks,
 * one number between them: the time they share today. Everything else on
 * the page exists to spend that time well.
 */
export const LiveWindow: React.FC<LiveWindowProps> = ({
  cityA,
  cityB,
  nameA,
  nameB,
  hasPeer,
  role = null
}) => {
  const [now, setNow] = useState(() => new Date());

  // Tick once a second so the countdown stays wall-clock accurate.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const info = computeLiveWindow(cityA.timezone, cityB.timezone, now);
  const activeSeconds =
    info.active && info.activeEnd !== null ? (info.activeEnd - info.nowLocalA) * 3600 : 0;
  const distanceKm = haversineKm(cityA.lat, cityA.lng, cityB.lat, cityB.lng);

  const scrollToActivities = () => {
    document.getElementById('activity-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const statusColor = info.active ? 'var(--accent)' : 'var(--text-muted)';
  const statusLabel = info.active ? 'Live now' : 'Next window';

  return (
    <section className="glass-panel full-width" aria-label="Our live window">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {/* The signature: their clock / the shared number / your clock. On a
            phone this stacks into the calm vertical composition. */}
        <div className="time-signature" aria-label="Local times and shared time today">
          {/* Person A */}
          <div className="sig-side">
            <span
              className="eyebrow"
              style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {role === 'a' && <span style={{ color: 'var(--primary)' }}>you · </span>}
              {nameA || 'User A'}
            </span>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {cityA.name}
            </div>
            <div className="time-display" style={{ marginTop: '6px' }}>
              {localTime(now, cityA.timezone)}
            </div>
          </div>

          <hr className="hairline sig-divider" aria-hidden="true" />

          {/* The one shared number */}
          <div className="sig-metric" style={{ textAlign: 'center', minWidth: '180px', padding: '0 8px' }}>
            <span className="eyebrow">shared time today</span>
            <div className="metric" style={{ marginTop: '2px' }}>
              {formatHours(info.totalHours)}
            </div>
            <div style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-secondary)', marginTop: '4px' }}>
              both awake &amp; free
            </div>
          </div>

          <hr className="hairline sig-divider" aria-hidden="true" />

          {/* Person B */}
          <div className="sig-side sig-side--them">
            <span
              className="eyebrow"
              style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {role === 'b' && <span style={{ color: 'var(--primary)' }}>you · </span>}
              {nameB || 'User B'}
            </span>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '2px' }}>
              {cityB.name}
            </div>
            <div className="time-display" style={{ marginTop: '6px' }}>
              {localTime(now, cityB.timezone)}
            </div>
          </div>
        </div>

        <hr className="hairline" />

        {/* The window itself: live countdown or when the next one opens. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-4)',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 'var(--text-label-size)',
                fontWeight: 600,
                color: statusColor,
                display: 'flex',
                alignItems: 'center',
                gap: '7px',
              }}
            >
              <span className="status-dot" style={{ background: statusColor }} />
              {statusLabel}
              {info.active && hasPeer ? ' · spend it together' : ''}
            </div>
            <div
              className="tabular"
              style={{
                fontSize: '22px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)',
                marginTop: '2px',
              }}
            >
              {info.active
                ? formatClock(activeSeconds)
                : info.nextOpenIn !== null
                  ? `in ${formatClock(info.nextOpenIn)}`
                  : '--:--'}
            </div>
            <div style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)', marginTop: '2px' }}>
              {info.active
                ? 'left in this window'
                : 'asynchronous until then'}
            </div>
          </div>

          <button
            onClick={scrollToActivities}
            className="btn btn-primary"
            aria-label="Launch a shared activity in the live window"
          >
            Spend it together
          </button>
        </div>

        <hr className="hairline" />

        {/* The physical fact, stated once, quietly. */}
        <div
          className="flex-between"
          style={{
            fontSize: 'var(--text-meta-size)',
            color: 'var(--text-muted)',
            flexWrap: 'wrap',
            gap: 'var(--space-2)',
          }}
        >
          <span className="tabular">
            {(distanceKm).toLocaleString(undefined, { maximumFractionDigits: 0 })} km apart
          </span>
          <span className="tabular">
            {(distanceKm * 0.621371).toLocaleString(undefined, { maximumFractionDigits: 0 })} miles
          </span>
          <span>{hasPeer ? 'peer online' : 'solo preview'}</span>
        </div>
      </div>
    </section>
  );
};
