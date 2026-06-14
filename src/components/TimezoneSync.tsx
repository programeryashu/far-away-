import React, { useState, useEffect } from 'react';
import { Clock, Sun, Moon } from 'lucide-react';

interface TimezoneSyncProps {
  cityA: { name: string; timezone: string };
  cityB: { name: string; timezone: string };
  nameA: string;
  nameB: string;
}

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

  const getUTCOffset = (timeZone: string, date = new Date()) => {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hour12: false
      });
      const parts = formatter.formatToParts(date);
      const getVal = (type: string) => {
        const p = parts.find(x => x.type === type);
        return p ? parseInt(p.value, 10) : 0;
      };

      const year = getVal('year');
      const month = getVal('month') - 1;
      const day = getVal('day');
      let hour = getVal('hour');
      if (hour === 24) hour = 0;
      const minute = getVal('minute');
      const second = getVal('second');

      const localWallTime = Date.UTC(year, month, day, hour, minute, second);
      return (localWallTime - date.getTime()) / 3600000;
    } catch (e) {
      return 0;
    }
  };

  const offsetA = getUTCOffset(cityA.timezone, time);
  const offsetB = getUTCOffset(cityB.timezone, time);
  const hourDiff = offsetB - offsetA;

  // Formatting strings
  const formatTime = (date: Date, timeZone: string) => {
    return date.toLocaleTimeString('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  };

  const formatDate = (date: Date, timeZone: string) => {
    return date.toLocaleDateString('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
  };

  // Determine sleep/work/free status based on local hour
  const getActivityStatus = (hour: number) => {
    const rounded = Math.floor((hour + 24) % 24);
    if (rounded >= 23 || rounded < 7) {
      return { label: 'Sleeping', emoji: '😴', class: 'status-sleep', color: '#818cf8' };
    } else if (rounded >= 9 && rounded < 17) {
      return { label: 'Working', emoji: '💼', class: 'status-work', color: '#f59e0b' };
    } else {
      return { label: 'Free Time', emoji: '☕', class: 'status-free', color: '#10b981' };
    }
  };

  // Live hours
  const liveHourA = (time.getUTCHours() + offsetA + 24) % 24;

  const currentHourA = useSlider ? sliderHour : liveHourA;
  const currentHourB = (currentHourA + hourDiff + 24) % 24;

  const statusA = getActivityStatus(currentHourA);
  const statusB = getActivityStatus(currentHourB);

  // Check if both are awake (7am to 11pm)
  const isOverlap = 
    Math.floor((currentHourA + 24) % 24) >= 7 && 
    Math.floor((currentHourA + 24) % 24) < 23 &&
    Math.floor((currentHourB + 24) % 24) >= 7 && 
    Math.floor((currentHourB + 24) % 24) < 23;

  return (
    <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Clock size={22} color="var(--primary)" />
        Temporal Chronology & Overlap
      </h2>

      {/* Clocks */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {/* User A Clock */}
        <div
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--border-glass)',
            padding: '16px',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center'
          }}
        >
          <div style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            {nameA || 'User A'}'s Local Time
          </div>
          <div style={{ fontSize: '24px', fontWeight: 700, margin: '6px 0', fontFamily: 'monospace' }}>
            {formatTime(time, cityA.timezone)}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            {formatDate(time, cityA.timezone)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            UTC {offsetA >= 0 ? '+' : ''}{offsetA.toFixed(1)}
          </div>
        </div>

        {/* User B Clock */}
        <div
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid var(--border-glass)',
            padding: '16px',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center'
          }}
        >
          <div style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            {nameB || 'User B'}'s Local Time
          </div>
          <div style={{ fontSize: '24px', fontWeight: 700, margin: '6px 0', fontFamily: 'monospace' }}>
            {formatTime(time, cityB.timezone)}
          </div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            {formatDate(time, cityB.timezone)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            UTC {offsetB >= 0 ? '+' : ''}{offsetB.toFixed(1)}
          </div>
        </div>
      </div>

      {/* Difference Banner */}
      <div
        style={{
          background: 'rgba(99, 102, 241, 0.05)',
          border: '1px dashed var(--border-glow)',
          padding: '12px',
          borderRadius: 'var(--radius-md)',
          textAlign: 'center',
          fontSize: '14px'
        }}
      >
        {hourDiff === 0 ? (
          <span>Users are in the <strong>same timezone</strong>. Coinciding matches are easy!</span>
        ) : (
          <span>
            {nameB || 'User B'} is{' '}
            <strong>
              {Math.abs(hourDiff).toFixed(1)} hours{' '}
              {hourDiff > 0 ? 'ahead of' : 'behind'}{' '}
            </strong>
            {nameA || 'User A'}.
          </span>
        )}
      </div>

      {/* Timeline slider for finding overlaps */}
      <div
        style={{
          borderTop: '1px solid var(--border-glass)',
          paddingTop: '20px'
        }}
      >
        <div className="flex-between" style={{ marginBottom: '12px' }}>
          <span style={{ fontSize: '13px', fontWeight: 600 }}>24-Hour Connection Planner</span>
          <button
            onClick={() => setUseSlider(!useSlider)}
            className="btn btn-outline"
            style={{ padding: '4px 10px', fontSize: '11px', borderRadius: '4px' }}
          >
            {useSlider ? 'Reset to Live' : 'Simulate Hours'}
          </button>
        </div>

        {useSlider && (
          <div style={{ marginBottom: '16px' }}>
            <input
              type="range"
              min="0"
              max="23"
              step="1"
              value={Math.floor(sliderHour)}
              onChange={(e) => setSliderHour(parseInt(e.target.value))}
              style={{ accentColor: 'var(--primary)', cursor: 'pointer' }}
            />
            <div style={{ textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Drag to plan a virtual meeting slot
            </div>
          </div>
        )}

        {/* Timeline Status Cards */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '12px' }}>
          {/* User A Hour status */}
          <div
            style={{
              padding: '12px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(255,255,255,0.01)',
              border: `1px solid ${statusA.color}30`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <div>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block' }}>{nameA || 'User A'}</span>
              <span style={{ fontSize: '15px', fontWeight: 600 }}>{Math.floor(currentHourA)}:00</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>{statusA.emoji}</span>
              <span style={{ fontSize: '13px', color: statusA.color, fontWeight: 500 }}>{statusA.label}</span>
            </div>
          </div>

          {/* User B Hour status */}
          <div
            style={{
              padding: '12px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(255,255,255,0.01)',
              border: `1px solid ${statusB.color}30`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <div>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block' }}>{nameB || 'User B'}</span>
              <span style={{ fontSize: '15px', fontWeight: 600 }}>{Math.floor(currentHourB)}:00</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>{statusB.emoji}</span>
              <span style={{ fontSize: '13px', color: statusB.color, fontWeight: 500 }}>{statusB.label}</span>
            </div>
          </div>
        </div>

        {/* Overlap Indicator */}
        <div
          style={{
            marginTop: '16px',
            padding: '12px',
            borderRadius: 'var(--radius-sm)',
            background: isOverlap ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
            border: `1px solid ${isOverlap ? 'var(--accent)' : 'rgba(239, 68, 68, 0.3)'}`,
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            fontSize: '13px'
          }}
        >
          {isOverlap ? (
            <>
              <Sun size={18} color="var(--accent)" />
              <div>
                <strong style={{ color: 'white' }}>Overlap Window Active!</strong> Both are awake and free to interact. Perfect time for sync activities.
              </div>
            </>
          ) : (
            <>
              <Moon size={18} color="#f87171" />
              <div>
                <strong style={{ color: '#f87171' }}>Asymmetric Window</strong> One user is in sleeping or working hours. Asynchronous messages recommended.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
