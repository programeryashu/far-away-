import React, { useEffect, useRef, useState } from 'react';
import { Zap, Activity } from 'lucide-react';
import type { Connection } from '../lib/connection';

interface PingMeterProps {
  /** Active transport (BroadcastChannel locally, WebSocket in a session). */
  connection: Connection;
  /** True when a second peer is connected right now. */
  hasPeer: boolean;
}

type PingStatus = 'idle' | 'pinging' | 'measured';

// How long we wait for a real pong before giving up on the in-flight ping.
const PONG_TIMEOUT_MS = 2000;

export const PingMeter: React.FC<PingMeterProps> = ({ connection, hasPeer }) => {
  const [status, setStatus] = useState<PingStatus>('idle');
  const [latency, setLatency] = useState<number | null>(null);
  const [lastPingedAt, setLastPingedAt] = useState<number | null>(null);

  // Track the in-flight ping's timestamp so a pong can be matched to it (and
  // stale pongs from earlier clicks are ignored). The solo simulation is a
  // transport concern now — the local connection answers its own pings — so
  // this component only ever waits for a real pong envelope.
  const pendingTsRef = useRef<number | null>(null);
  const failTimerRef = useRef<number | null>(null);

  // A pong from the connection (either transport) is matched against the
  // last ping we sent by timestamp and turned into a measured round-trip.
  useEffect(() => {
    return connection.onEvent((env) => {
      // The pong payload is schema-validated: ts is a number echoed from our
      // own ping, so only a matching in-flight timestamp counts.
      if (env.event === 'pong' && pendingTsRef.current !== null && env.payload.ts === pendingTsRef.current) {
        if (failTimerRef.current !== null) window.clearTimeout(failTimerRef.current);
        failTimerRef.current = null;
        pendingTsRef.current = null;
        setLatency(Date.now() - env.payload.ts);
        setStatus('measured');
      }
    });
  }, [connection]);

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      if (failTimerRef.current !== null) window.clearTimeout(failTimerRef.current);
    };
  }, []);

  const measure = () => {
    const ts = Date.now();
    pendingTsRef.current = ts;
    setStatus('pinging');
    setLatency(null);
    setLastPingedAt(ts);

    // The connection routes the ping: real WebSocket round-trip in a session,
    // real BroadcastChannel round-trip to a local peer, simulated pong solo.
    connection.send('ping', { ts });
    failTimerRef.current = window.setTimeout(() => {
      if (pendingTsRef.current === ts) {
        pendingTsRef.current = null;
        failTimerRef.current = null;
        setStatus('idle');
      }
    }, PONG_TIMEOUT_MS);
  };

  const lightColor =
    status === 'measured'
      ? 'var(--accent)'
      : status === 'pinging'
        ? 'var(--secondary)'
        : 'var(--text-muted)';

  const lightGlow =
    status === 'measured'
      ? '0 0 18px rgba(20, 184, 166, 0.6)'
      : status === 'pinging'
        ? '0 0 18px rgba(251, 191, 36, 0.5)'
        : 'none';

  const display =
    latency !== null
      ? `~${latency} ms`
      : status === 'pinging'
        ? 'traversing…'
        : '—';

  return (
    <div className="glass-panel full-width" aria-label="Ping the light — measured latency">
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* The light: dim when idle, pulses amber while pinging, glows
              teal once the peer's pong has been measured. */}
          <div
            style={{
              width: '44px',
              height: '44px',
              borderRadius: '50%',
              background: `radial-gradient(circle, ${lightColor} 0%, transparent 75%)`,
              border: `2px solid ${status === 'pinging' ? 'var(--secondary)' : 'rgba(255,255,255,0.15)'}`,
              boxShadow: lightGlow,
              animation: status === 'pinging' ? 'pulse-glow 0.7s infinite ease-in-out' : 'none',
              transition: 'background 0.3s, box-shadow 0.3s, border-color 0.3s'
            }}
          />
          <div>
            <h2 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Zap size={18} color="var(--primary)" />
              Ping the Light
            </h2>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {connection.mode === 'remote'
                ? 'real WebSocket round-trip'
                : hasPeer
                  ? 'real BroadcastChannel round-trip'
                  : 'solo · sim fallback'}
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
              Round-trip
            </div>
            <div
              style={{
                fontSize: '22px',
                fontWeight: 700,
                fontFamily: 'monospace',
                color: status === 'measured' ? 'var(--accent)' : 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <Activity size={14} color="var(--text-muted)" />
              {display}
            </div>
          </div>

          <button
            onClick={measure}
            className="btn btn-primary"
            style={{ padding: '8px 18px', fontSize: '13px' }}
            aria-label="Send a ping and measure round-trip latency"
          >
            <Zap size={14} />
            {status === 'pinging' ? 'Pinging…' : 'Send Ping'}
          </button>
        </div>
      </div>

      {lastPingedAt !== null && status === 'idle' && latency === null && (
        <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
          No answer — open a second tab of this app to measure a real round-trip.
        </div>
      )}
    </div>
  );
};
