import React, { useEffect, useRef, useState } from 'react';
import { Zap } from 'lucide-react';
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

  const display =
    latency !== null
      ? `~${latency} ms`
      : status === 'pinging'
        ? 'measuring…'
        : '—';

  return (
    <div className="quiet-strip" aria-label="Ping the light — measured latency">
      <div className="flex-between" style={{ flexWrap: 'wrap', gap: 'var(--space-4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', minWidth: 0 }}>
          {/* The light: dim when idle, pulses amber while pinging, steady
              teal once the peer's pong has been measured. */}
          <span
            className="status-dot"
            style={{
              width: 9,
              height: 9,
              background: lightColor,
              animation: status === 'pinging' ? 'pulse-soft 1s ease-in-out infinite' : 'none'
            }}
          />
          <div style={{ minWidth: 0 }}>
            <span style={{ fontSize: 'var(--text-label-size)', fontWeight: 600 }}>
              Ping the light
            </span>
            <div style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)' }}>
              {connection.mode === 'remote'
                ? 'a round-trip over your live session'
                : hasPeer
                  ? 'a round-trip between your tabs'
                  : 'solo: open a second tab to measure a real round-trip'}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-5)' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)' }}>
              Round-trip
            </div>
            <div
              className="tabular"
              style={{
                fontSize: '20px',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
                color: status === 'measured' ? 'var(--accent)' : 'var(--text-secondary)'
              }}
            >
              {display}
            </div>
          </div>

          <button
            onClick={measure}
            className="btn btn-outline"
            style={{ padding: '8px 16px', fontSize: 'var(--text-label-size)' }}
            aria-label="Send a ping and measure round-trip latency"
          >
            <Zap size={14} />
            {status === 'pinging' ? 'Pinging…' : 'Send ping'}
          </button>
        </div>
      </div>

      {lastPingedAt !== null && status === 'idle' && latency === null && (
        <div style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)' }}>
          No answer. Open a second tab of this app to measure a real round-trip.
        </div>
      )}
    </div>
  );
};
