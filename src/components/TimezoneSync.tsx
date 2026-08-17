import React, { useState, useEffect } from 'react';
import { getUTCOffsetHours } from '../lib/time';

interface TimezoneSyncProps {
  cityA: { name: string; timezone: string };
  cityB: { name: string; timezone: string };
  nameA: string;
  nameB: string;
}

/** Day-model shared with the live-window math: awake 7–23, working 9–17. */
function statusAt(hour: number): { label: string; kind: 'sleep' | 'work' | 'free' } {
  const h = Math.floor((hour + 24) % 24);
  if (h >= 23 || h < 7) return { label: 'Sleeping', kind: 'sleep' };
  if (h >= 9 && h < 17) return { label: 'Working', kind: 'work' };
  return { label: 'Free', kind: 'free' };
}

const STATUS_FILL: Record<'sleep' | 'work' | 'free', string> = {
  sleep: 'rgba(255, 255, 255, 0.05)',
  work: 'rgba(224, 123, 180, 0.16)',
  free: 'rgba(62, 207, 174, 0.16)',
};

/**
 * The day ribbon — 24 hours seen twice, once for each person. Time is
 * Orbit's visual language: this is a planning surface, not a clock widget.
 * The slider scrubs "what if it were another hour" without touching
 * anything live.
 */
export const TimezoneSync: React.FC<TimezoneSyncProps> = ({
  cityA,
  cityB,
  nameA,
  nameB
}) => {
  const [time, setTime] = useState(new Date());
  const [sliderHour, setSliderHour] = useState<number>(new Date().getHours());
  const [useSlider, setUseSlider] = useState<boolean>(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const offsetA = getUTCOffsetHours(cityA.timezone, time);
  const offsetB = getUTCOffsetHours(cityB.timezone, time);
  const hourDiff = offsetB - offsetA;

  const formatTime = (date: Date, timeZone: string) => {
    try {
      return date.toLocaleTimeString('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      });
    } catch {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
  };

  const formatDate = (date: Date, timeZone: string) => {
    try {
      return date.toLocaleDateString('en-US', { timeZone, weekday: 'short' });
    } catch {
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    }
  };

  const liveHourA = (time.getUTCHours() + time.getUTCMinutes() / 60 + offsetA + 24) % 24;
  const currentHourA = useSlider ? sliderHour : liveHourA;
  const currentHourB = (currentHourA + hourDiff + 24) % 24;

  const statusA = statusAt(currentHourA);
  const statusB = statusAt(currentHourB);
  const overlapNow = statusA.kind !== 'sleep' && statusB.kind !== 'sleep';

  // One cell per hour on a shared 0–24 axis in A's local time. B's cell for
  // the same slot shows B's status at that moment — the two ribbons align,
  // and the gaps between the colored regions are the real distance.
  const hoursA = Array.from({ length: 24 }, (_, h) => h);
  const hoursB = hoursA.map((h) => (h + hourDiff + 24) % 24);

  const labelA = nameA || 'User A';
  const labelB = nameB || 'User B';

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="flex-between" style={{ gap: 'var(--space-3)' }}>
        <h2 className="section-title">Plan around time</h2>
        <button
          onClick={() => setUseSlider(!useSlider)}
          className="btn btn-outline"
          style={{ padding: '4px 12px', fontSize: 'var(--text-meta-size)' }}
          aria-pressed={useSlider}
        >
          {useSlider ? 'Back to now' : 'Try another hour'}
        </button>
      </div>

      {/* The two lanes */}
      <div aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {[
          { hours: hoursA, own: hoursA.map((h) => h), key: 'a' },
          { hours: hoursB, own: hoursA, key: 'b' },
        ].map(({ hours, own, key }) => (
          <div key={key} style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: '2px' }}>
            {hours.map((h, i) => {
              const status = statusAt(h);
              const isNow = Math.floor(useSlider ? sliderHour : liveHourA) === own[i];
              return (
                <div
                  key={i}
                  style={{
                    height: '14px',
                    borderRadius: '2px',
                    background: STATUS_FILL[status.kind],
                    outline: isNow ? '1.5px solid var(--text-primary)' : 'none',
                    outlineOffset: isNow ? '1px' : 0,
                  }}
                />
              );
            })}
          </div>
        ))}
        {/* Hour scale */}
        <div
          className="tabular"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)' }}
        >
          {/* Midnight and noon both read "12a"; index-keyed so the two
              occurrences are distinct React children. */}
          {['12a', '6a', '12p', '6p', '12a'].map((t, i) => (
            <span key={`${t}-${i}`}>{t}</span>
          ))}
        </div>
      </div>

      {/* What the lanes mean right now */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 'var(--space-3)',
          fontSize: 'var(--text-label-size)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-meta-size)' }}>
            {labelA} · {cityA.name}
          </div>
          <div className="tabular" style={{ fontWeight: 600, marginTop: '2px' }}>
            {formatTime(time, cityA.timezone)}{' '}
            <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>{formatDate(time, cityA.timezone)}</span>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-meta-size)', marginTop: '2px' }}>
            <span className={`status-${statusA.kind}`} style={{ fontWeight: 500 }}>{statusA.label}</span>
            {' · '}UTC{offsetA >= 0 ? '+' : ''}{offsetA.toFixed(1)}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-meta-size)' }}>
            {labelB} · {cityB.name}
          </div>
          <div className="tabular" style={{ fontWeight: 600, marginTop: '2px' }}>
            {formatTime(time, cityB.timezone)}{' '}
            <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}>{formatDate(time, cityB.timezone)}</span>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-meta-size)', marginTop: '2px' }}>
            <span className={`status-${statusB.kind}`} style={{ fontWeight: 500 }}>{statusB.label}</span>
            {' · '}UTC{offsetB >= 0 ? '+' : ''}{offsetB.toFixed(1)}
          </div>
        </div>
      </div>

      <hr className="hairline" />

      {/* The one-line answer + the scrub */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <div style={{ fontSize: 'var(--text-label-size)', color: 'var(--text-secondary)' }}>
          {hourDiff === 0 ? (
            <>{labelA} and {labelB} share a timezone — every hour is a shared hour.</>
          ) : (
            <>
              {labelB} is{' '}
              <strong style={{ color: 'var(--text-primary)' }}>
                {Math.abs(hourDiff).toFixed(1)} hours {hourDiff > 0 ? 'ahead of' : 'behind'}{' '}
              </strong>
              {labelA}.
            </>
          )}
        </div>

        {useSlider && (
          <div>
            <label htmlFor="hour-scrub" style={{ marginBottom: '4px' }}>
              {labelA}'s hour: {Math.floor(sliderHour)}:00 → {labelB} at {Math.floor(currentHourB)}:00
            </label>
            <input
              id="hour-scrub"
              type="range"
              min="0"
              max="23"
              step="1"
              value={Math.floor(sliderHour)}
              onChange={(e) => setSliderHour(parseInt(e.target.value))}
              aria-label="Scrub the hour of the day"
            />
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            fontSize: 'var(--text-label-size)',
            color: overlapNow ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <span className="status-dot" style={{ background: overlapNow ? 'var(--accent)' : 'var(--text-muted)' }} />
          {overlapNow ? (
            <span>
              Both awake right now — a good moment for something shared.
            </span>
          ) : (
            <span>
              One of you is asleep. Leave a message they'll get in their morning.
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
