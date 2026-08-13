import React, { useEffect, useRef, useState } from 'react';
import { Zap, Activity } from 'lucide-react';
import type { OrbitSync } from '../lib/broadcast';
import type { SessionManager } from '../lib/session';

interface PingMeterProps {
  /** Live-tab sync channel; null when BroadcastChannel is unavailable. */
  sync: OrbitSync | null;
  /** Session Manager for backend-driven sessions */
  sessionManager?: SessionManager | null;
  /** True when a second tab is connected right now. */
  hasPeer: boolean;
}

type PingStatus = 'idle' | 'pinging' | 'measured';

// How long we wait for a real pong before giving up on the in-flight ping.
const PONG_TIMEOUT_MS = 2000;

// Solo fallback: simulate a peer's pong so the demo still lights up.
const SIM_MIN_MS = 25;
const SIM_MAX_MS = 90;

export const PingMeter: React.FC<PingMeterProps> = ({ sync, sessionManager, hasPeer }) => {
  const [status, setStatus] = useState<PingStatus>('idle');
  const [latency, setLatency] = useState<number | null>(null);
  const [lastPingedAt, setLastPingedAt] = useState<number | null>(null);

  // Track the in-flight ping's timestamp so a pong can be matched to it (and
  // stale pongs from earlier clicks are ignored).
  const pendingTsRef = useRef<number | null>(null);
  const failTimerRef = useRef<number | null>(null);
  const simTimerRef = useRef<number | null>(null);

  // Peer's ping → answer it with a pong carrying the same timestamp so the
  // peer can measure round-trip. Our own pong → match it against the last
  // ping we sent and compute RTT.
  useEffect(() => {
    if (sessionManager) {
        return sessionManager.onEvent((env) => {
            // The pong payload is schema-validated: ts is a number that the
            // server echoed from our own ping, so only a matching in-flight
            // timestamp counts as this measurement.
            if (env.event === 'pong' && pendingTsRef.current !== null && env.payload.ts === pendingTsRef.current) {
                if (failTimerRef.current !== null) window.clearTimeout(failTimerRef.current);
                if (simTimerRef.current !== null) window.clearTimeout(simTimerRef.current);
                failTimerRef.current = null;
                simTimerRef.current = null;
                pendingTsRef.current = null;
                setLatency(Date.now() - env.payload.ts);
                setStatus('measured');
            }
        });
    }

    if (!sync) return;
    return sync.onMessage((msg) => {
      if (msg.type === 'ping') {
        sync.sendPong(msg.ts);
      } else if (msg.type === 'pong' && pendingTsRef.current !== null && msg.ts === pendingTsRef.current) {
        if (failTimerRef.current !== null) window.clearTimeout(failTimerRef.current);
        if (simTimerRef.current !== null) window.clearTimeout(simTimerRef.current);
        failTimerRef.current = null;
        simTimerRef.current = null;
        pendingTsRef.current = null;
        setLatency(Date.now() - msg.ts);
        setStatus('measured');
      }
    });
  }, [sync, sessionManager]);

  // Cleanup timers on unmount.
  useEffect(() => {
    return () => {
      if (failTimerRef.current !== null) window.clearTimeout(failTimerRef.current);
      if (simTimerRef.current !== null) window.clearTimeout(simTimerRef.current);
    };
  }, []);

  const measure = () => {
    const ts = Date.now();
    pendingTsRef.current = ts;
    setStatus('pinging');
    setLatency(null);
    setLastPingedAt(ts);

    if (sessionManager) {
        sessionManager.send('ping', { ts });
        failTimerRef.current = window.setTimeout(() => {
          if (pendingTsRef.current === ts) {
            pendingTsRef.current = null;
            failTimerRef.current = null;
            setStatus('idle');
          }
        }, PONG_TIMEOUT_MS);
    } else if (sync && hasPeer) {
      // Real round-trip across the BroadcastChannel.
      sync.sendPing(ts);
      failTimerRef.current = window.setTimeout(() => {
        if (pendingTsRef.current === ts) {
          pendingTsRef.current = null;
          failTimerRef.current = null;
          setStatus('idle');
        }
      }, PONG_TIMEOUT_MS);
    } else {
      // Offline fallback: emulate the peer's reply.
      simTimerRef.current = window.setTimeout(() => {
        if (pendingTsRef.current === ts) {
          pendingTsRef.current = null;
          simTimerRef.current = null;
          setLatency(Math.round(4 + Math.random() * 20));
          setStatus('measured');
        }
      }, SIM_MIN_MS + Math.random() * (SIM_MAX_MS - SIM_MIN_MS));
    }
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
              {sessionManager
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
