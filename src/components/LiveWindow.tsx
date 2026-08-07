import React, { useEffect, useState } from 'react';
import { Clock, Radio, Sparkles } from 'lucide-react';
import { computeLiveWindow, formatClock } from '../lib/time';
import type { OrbitSync } from '../lib/broadcast';

interface LiveWindowProps {
  cityA: { name: string; timezone: string };
  cityB: { name: string; timezone: string };
  nameA: string;
  nameB: string;
  sync: OrbitSync | null;
  hasPeer: boolean;
}

const formatHours = (hours: number): string => {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
};

export const LiveWindow: React.FC<LiveWindowProps> = ({
  cityA,
  cityB,
  nameA,
  nameB,
  hasPeer
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

  const scrollToActivities = () => {
    document.getElementById('activity-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const statusColor = info.active ? 'var(--accent)' : 'var(--text-muted)';
  const statusLabel = info.active ? 'LIVE NOW' : 'WAITING FOR LIVE TIME';

  return (
    <section
      className="glass-panel full-width"
      style={{ position: 'relative', overflow: 'hidden' }}
      aria-label="Our live window"
    >
      {/* Soft background glow that matches the active/inactive state */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: info.active
            ? 'radial-gradient(ellipse at 20% 0%, rgba(20,184,166,0.12) 0%, transparent 60%)'
            : 'radial-gradient(ellipse at 20% 0%, rgba(99,102,241,0.08) 0%, transparent 60%)',
          pointerEvents: 'none'
        }}
      ></div>

      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <div className="flex-between">
          <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Clock size={22} color={statusColor} />
            Our Live Window
          </h2>
          <span
            className="badge badge-accent"
            style={{
              fontSize: '10px',
              borderColor: hasPeer ? 'rgba(20, 184, 166, 0.4)' : 'var(--border-glass)',
              color: hasPeer ? '#99f6e4' : 'var(--text-muted)'
            }}
          >
            {hasPeer ? (
              <>
                <Radio size={10} style={{ marginRight: 4 }} /> 2 tabs live
              </>
            ) : (
              'solo · sim fallback'
            )}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            alignItems: 'center',
            gap: '24px',
            flexWrap: 'wrap'
          }}
        >
          {/* Headline stat */}
          <div style={{ textAlign: 'left', minWidth: '180px' }}>
            <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
              Live time today
            </div>
            <div
              style={{
                fontSize: '40px',
                fontWeight: 800,
                letterSpacing: '-0.03em',
                lineHeight: 1.1,
                color: info.totalHours > 0 ? '#fff' : 'var(--text-muted)'
              }}
            >
              {formatHours(info.totalHours)}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {nameA || 'User A'} × {nameB || 'User B'} both awake &amp; free
            </div>
          </div>

          {/* Countdown / next window */}
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                fontSize: '13px',
                fontWeight: 700,
                letterSpacing: '0.05em',
                textTransform: 'uppercase',
                color: statusColor
              }}
            >
              {statusLabel}
            </div>
            {info.active ? (
              <div
                style={{
                  fontSize: '28px',
                  fontWeight: 800,
                  fontFamily: 'monospace',
                  color: 'var(--accent)',
                  marginTop: '4px',
                  animation: 'pulse-glow 2s infinite ease-in-out'
                }}
              >
                {formatClock(activeSeconds)}
              </div>
            ) : (
              <div style={{ fontSize: '18px', fontFamily: 'monospace', color: 'var(--text-secondary)', marginTop: '6px' }}>
                next window opens in {info.nextOpenIn !== null ? formatClock(info.nextOpenIn) : '--:--'}
              </div>
            )}
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              {info.active
                ? 'until this live block ends — spend it together'
                : 'asynchronous until then — queue a message'}
            </div>
          </div>

          {/* CTA */}
          <div style={{ textAlign: 'right' }}>
            <button
              onClick={scrollToActivities}
              className="btn btn-primary"
              style={{ gap: '8px' }}
              aria-label="Launch a shared activity in the live window"
            >
              <Sparkles size={16} />
              Spend it together
            </button>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
              Cinema · Canvas · Focus timer
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
