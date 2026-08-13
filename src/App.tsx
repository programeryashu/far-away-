import { useCallback, useEffect, useRef, useState } from 'react';
import { LocationSelector } from './components/LocationSelector';
import { DistanceVisualizer } from './components/DistanceVisualizer';
import { TimezoneSync } from './components/TimezoneSync';
import { LiveWindow } from './components/LiveWindow';
import { PingMeter } from './components/PingMeter';
import { ActivityFinder } from './components/ActivityFinder';
import { ChatBox } from './components/ChatBox';
import { Globe, Heart, Share2, Check, LogOut } from 'lucide-react';
import { FALLBACK_CITIES, type CityData } from './lib/cities';
import { buildShareUrl, isValidConnectionState, parseShareUrl, type ConnectionState } from './lib/share';
import { OrbitSync } from './lib/broadcast';
import { clearSession, loadSession, persistSession, SessionManager, type ClientSession } from './lib/session';
import { ApiError, createSession, joinSession, leaveSession } from './lib/api';
import { identityFromParts, otherPeers, peerIdentity, type ServerPeer } from './lib/reconcile';
import type { ConnectionStatus } from './lib/realtime';

const STORAGE_KEY = 'faraway.connection';

const DEFAULT_STATE: ConnectionState = {
  a: { name: 'Yash', city: FALLBACK_CITIES[0] }, // San Francisco
  b: { name: 'Kimi', city: FALLBACK_CITIES[1] } // Tokyo
};

// Load order: URL query params → localStorage → defaults
function loadInitialState(): ConnectionState {
  const fromUrl = parseShareUrl();
  if (fromUrl) return fromUrl;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValidConnectionState(parsed)) return parsed;
    }
  } catch {
    // Malformed or unavailable storage — fall through to defaults
  }
  return DEFAULT_STATE;
}

// Fallback clipboard write when the async Clipboard API is unavailable.
// Returns true only if the browser actually copied.
function copyFallback(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    // execCommand may throw — ok stays false
  }
  document.body.removeChild(textarea);
  return ok;
}

type SessionState = 'local' | 'joining' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

const SESSION_PARAM = 'session';

function parseSessionParam(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.get(SESSION_PARAM);
}

/** Map an API failure to a friendly message — never surface raw server errors. */
function friendlySessionError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === null) {
      return 'Cannot reach the Orbit server. Make sure the backend is running, then try again.';
    }
    if (err.status === 404 || err.status === 410) {
      return 'This invite is invalid or has expired.';
    }
    if (err.status === 409) {
      return 'This session is already full.';
    }
    return 'Could not connect to the session. Please try again.';
  }
  return 'Could not connect to the session. Please try again.';
}

function App() {
  const [initial] = useState(loadInitialState);
  const [userNameA, setUserNameA] = useState(initial.a.name);
  const [selectedCityA, setSelectedCityA] = useState<CityData>(initial.a.city);
  const [userNameB, setUserNameB] = useState(initial.b.name);
  const [selectedCityB, setSelectedCityB] = useState<CityData>(initial.b.city);
  const [copied, setCopied] = useState(false);
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Live-tab sync: one OrbitSync for the app lifetime. It must run in EVERY
  // mode (local two-tab mode, and as an idle fallback during a session) so the
  // BroadcastChannel is always available when the UI is in local mode.
  const [sync] = useState(() => new OrbitSync());
  const [hasRemotePeer, setHasRemotePeer] = useState(false);

  const [urlSessionId] = useState(() => parseSessionParam(window.location.search));
  const [persistedSession] = useState(loadSession);
  const [sessionState, setSessionState] = useState<SessionState>(() => {
    if (urlSessionId) return 'joining';
    if (persistedSession) return 'joining';
    return 'local';
  });
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [sm, setSm] = useState<SessionManager | null>(null);
  const smRef = useRef<SessionManager | null>(null);
  useEffect(() => {
    smRef.current = sm;
  }, [sm]);
  // While an invite URL is open the role is unknown until the join response;
  // a stale persisted role from a different session must not apply.
  const [myRole, setMyRole] = useState<'a' | 'b' | null>(() => {
    if (urlSessionId) return null;
    return persistedSession?.role ?? null;
  });
  const remotePeerIdsRef = useRef<Set<string>>(new Set());

  // Start the BroadcastChannel in every mode so local two-tab fallback works.
  useEffect(() => {
    sync.start();
    return () => sync.dispose();
  }, [sync]);

  // Persist the connection whenever either person's name or city changes, so
  // identity (including post-join edits) survives a reload.
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          a: { name: userNameA, city: selectedCityA },
          b: { name: userNameB, city: selectedCityB }
        })
      );
    } catch {
      // Storage may be unavailable (private mode / quota) — ignore.
    }
  }, [userNameA, selectedCityA, userNameB, selectedCityB]);

  const applyIdentity = useCallback(
    (role: 'a' | 'b', identity: { name: string; city: CityData | null }) => {
      if (role === 'a') {
        setUserNameA(identity.name);
        if (identity.city) setSelectedCityA(identity.city);
      } else {
        setUserNameB(identity.name);
        if (identity.city) setSelectedCityB(identity.city);
      }
    },
    []
  );

  const applyPeerIdentity = useCallback(
    (peer: ServerPeer) => {
      const identity = peerIdentity(peer);
      if (identity) applyIdentity(peer.role, identity);
    },
    [applyIdentity]
  );

  // Debounced push of my own identity to the server. Only fires for the role
  // this tab owns; the peerId used server-side comes from the authenticated
  // socket, so a peer can never edit the other side.
  const identityTimerRef = useRef<number | null>(null);
  const pendingIdentityRef = useRef<{ role: 'a' | 'b'; name: string; city: CityData | null } | null>(null);
  const scheduleIdentityPush = useCallback((role: 'a' | 'b', name: string, city: CityData | null) => {
    pendingIdentityRef.current = { role, name, city };
    if (identityTimerRef.current !== null) window.clearTimeout(identityTimerRef.current);
    identityTimerRef.current = window.setTimeout(() => {
      identityTimerRef.current = null;
      const pending = pendingIdentityRef.current;
      if (!pending) return;
      const manager = smRef.current;
      if (!manager || manager.role !== pending.role) return;
      manager.send('identity-update', {
        displayName: pending.name || 'Peer',
        city: pending.city
      });
    }, 600);
  }, []);

  // Owned-side setters: local state always updates; in a remote session the
  // change is also pushed to the server (debounced) so it survives reload and
  // reaches the other peer.
  const setOwnNameA = (val: string) => {
    setUserNameA(val);
    if (myRole === 'a') scheduleIdentityPush('a', val, selectedCityA);
  };
  const setOwnCityA = (city: CityData) => {
    setSelectedCityA(city);
    if (myRole === 'a') scheduleIdentityPush('a', userNameA, city);
  };
  const setOwnNameB = (val: string) => {
    setUserNameB(val);
    if (myRole === 'b') scheduleIdentityPush('b', val, selectedCityB);
  };
  const setOwnCityB = (city: CityData) => {
    setSelectedCityB(city);
    if (myRole === 'b') scheduleIdentityPush('b', userNameB, city);
  };

  // Wire one SessionManager: status → UI state, events → presence/identity.
  const attachManager = useCallback((manager: SessionManager) => {
    manager.onStatusChange((status: ConnectionStatus) => {
      if (status === 'connected') setSessionState('connected');
      else if (status === 'reconnecting') setSessionState('reconnecting');
      else if (status === 'disconnected') setSessionState('disconnected');
      else if (status === 'error') {
        setSessionState('error');
        setSessionError(
          'This session is no longer available — it may have expired. Leave it and start a new one.'
        );
      }
    });

    // Envelopes arrive already validated against the server union, so the
    // payload of each event is fully typed — no casts, nothing to re-check.
    manager.onEvent((env) => {
      if (env.event === 'state') {
        // State catch-up identifies the peer but does NOT set live presence:
        // a peer that has joined (database membership) may not have its
        // socket up. Presence is driven only by peer-joined/peer-left.
        const others = otherPeers(env.payload.peers, manager.peerId);
        for (const peer of others) applyPeerIdentity(peer);
      } else if (env.event === 'peer-joined') {
        // Never treat our own identity (a duplicate tab) as a remote peer.
        if (env.payload.peerId !== manager.peerId) {
          remotePeerIdsRef.current.add(env.payload.peerId);
          setHasRemotePeer(true);
          const otherRole = manager.role === 'a' ? 'b' : 'a';
          const identity = identityFromParts(env.payload.displayName ?? '', env.payload.cityJson ?? '');
          if (identity) applyIdentity(otherRole, identity);
        }
      } else if (env.event === 'peer-left') {
        if (env.payload.peerId !== manager.peerId) {
          remotePeerIdsRef.current.delete(env.payload.peerId);
          setHasRemotePeer(remotePeerIdsRef.current.size > 0);
        }
      } else if (env.event === 'peer-updated') {
        if (env.payload.peerId !== manager.peerId) {
          const otherRole = manager.role === 'a' ? 'b' : 'a';
          const identity = identityFromParts(env.payload.displayName ?? '', env.payload.cityJson ?? '');
          if (identity) applyIdentity(otherRole, identity);
        }
      }
    });

    manager.start();
    setSm(manager);
    setMyRole(manager.role);
  }, [applyIdentity, applyPeerIdentity]);

  // Reconnect a persisted session: either there is no invite URL, or the invite
  // URL points at the same session we already joined (reload of an invite
  // link). A different invite is handled by the join panel instead.
  useEffect(() => {
    if (!persistedSession) return;
    if (urlSessionId && persistedSession.sessionId !== urlSessionId) return;
    const manager = new SessionManager(persistedSession);
    attachManager(manager);
    if (urlSessionId) window.history.replaceState(null, '', window.location.pathname);
    return () => manager.stop();
  }, [urlSessionId, persistedSession, attachManager]);

  // Broadcast the full connection whenever either person's name or city
  // changes; a peer merges only its own side and ignores the rest.
  useEffect(() => {
    // Only broadcast via OrbitSync if in local mode
    if (sessionState !== 'local') return;

    sync.sendNames(userNameA, userNameB);
    sync.sendConnection({
      a: { name: userNameA, city: selectedCityA },
      b: { name: userNameB, city: selectedCityB }
    });
  }, [sync, userNameA, userNameB, selectedCityA, selectedCityB, sessionState]);

  const copyToClipboard = async (url: string) => {
    let ok = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = copyFallback(url);

    setManualCopyUrl(null);
    if (ok) {
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } else {
      // Both clipboard paths failed — surface the link for manual copy
      setManualCopyUrl(url);
    }
  };

  const sessionShareUrl = (sessionId: string) =>
    `${window.location.origin}${window.location.pathname}?session=${sessionId}`;

  const handleShare = async () => {
    if (sessionState === 'local') {
      try {
        setSessionState('joining');
        const { id } = await createSession();
        const res = await joinSession(id, userNameA || 'User A', selectedCityA);
        const session: ClientSession = { sessionId: id, peerId: res.peerId, role: res.role };
        persistSession(session);
        attachManager(new SessionManager(session));
        await copyToClipboard(sessionShareUrl(id));
      } catch (err) {
        if (err instanceof ApiError && err.status === null) {
          // Backend genuinely unreachable — fall back to the old local share
          // link so the button still works in a server-less demo.
          setSessionState('local');
          await copyToClipboard(
            buildShareUrl({
              a: { name: userNameA, city: selectedCityA },
              b: { name: userNameB, city: selectedCityB }
            })
          );
        } else {
          setSessionState('error');
          setSessionError(friendlySessionError(err));
        }
      }
    } else {
      // Already in a session — re-share the same session link.
      const existing = loadSession();
      if (existing) await copyToClipboard(sessionShareUrl(existing.sessionId));
    }
  };

  // Invitee join: User B opens ?session=<id>, enters identity, joins, connects.
  const handleJoin = async () => {
    if (!urlSessionId) return;
    setSessionError(null);
    try {
      const res = await joinSession(urlSessionId, userNameB || 'User B', selectedCityB);
      const session: ClientSession = { sessionId: urlSessionId, peerId: res.peerId, role: res.role };
      persistSession(session);
      // Strip the invite param so a reload reconnects via the persisted
      // session instead of re-joining (which would answer 409 session full).
      window.history.replaceState(null, '', window.location.pathname);
      attachManager(new SessionManager(session));
    } catch (err) {
      setSessionState('error');
      setSessionError(friendlySessionError(err));
    }
  };

  // Leave: stop the manager, close the WS, clear remote session state, return
  // to local mode. Local names/cities and other app data are untouched.
  const handleLeave = async () => {
    const session = loadSession();
    if (session) {
      try {
        await leaveSession(session.sessionId, session.peerId);
      } catch {
        // Best effort — local cleanup proceeds regardless.
      }
    }
    sm?.stop();
    if (identityTimerRef.current !== null) window.clearTimeout(identityTimerRef.current);
    identityTimerRef.current = null;
    pendingIdentityRef.current = null;
    clearSession();
    setSm(null);
    setMyRole(null);
    setHasRemotePeer(false);
    remotePeerIdsRef.current.clear();
    setSessionError(null);
    setSessionState('local');
    if (urlSessionId) window.history.replaceState(null, '', window.location.pathname);
  };

  const sessionStatusLabel: Record<SessionState, string> = {
    local: 'Local mode',
    joining: 'Joining…',
    connected: hasRemotePeer ? 'Connected · peer online' : 'Connected · waiting for peer',
    reconnecting: 'Reconnecting…',
    disconnected: 'Disconnected',
    error: 'Session unavailable'
  };

  const statusColor =
    sessionState === 'connected'
      ? 'var(--accent)'
      : sessionState === 'error'
        ? '#f87171'
        : sessionState === 'joining' || sessionState === 'reconnecting'
          ? 'var(--secondary)'
          : 'var(--text-muted)';

  return (
    <div id="root">
      {/* Header section with brand info */}
      <header style={{ borderBottom: '1px solid var(--border-glass)', background: 'rgba(7, 9, 19, 0.4)', backdropFilter: 'blur(8px)', padding: '20px 0', position: 'sticky', top: 0, zIndex: 50 }}>
        <div
          style={{
            maxWidth: '1280px',
            margin: '0 auto',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
                width: '40px',
                height: '40px',
                borderRadius: 'var(--radius-sm)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 15px rgba(99, 102, 241, 0.4)'
              }}
            >
              <Globe size={22} color="white" />
            </div>
            <div>
              <h1
                style={{
                  fontSize: '22px',
                  fontWeight: 800,
                  background: 'linear-gradient(to right, #ffffff, #c7d2fe)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  margin: 0,
                  letterSpacing: '-0.02em'
                }}
              >
                Orbit
              </h1>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Live time is the only time. Make the most of it.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              className="badge"
              style={{
                fontSize: '11px',
                borderColor: statusColor,
                color: statusColor,
                animation:
                  sessionState === 'joining' || sessionState === 'reconnecting'
                    ? 'pulse-glow 1.5s infinite ease-in-out'
                    : 'none'
              }}
              aria-live="polite"
            >
              {sessionStatusLabel[sessionState]}
            </span>
            {sessionState !== 'local' && (
              <button
                onClick={handleLeave}
                className="btn btn-outline"
                style={{ padding: '8px 14px', fontSize: '12px', gap: '6px', borderRadius: 'var(--radius-sm)' }}
                aria-label="Leave the current session and return to local mode"
              >
                <LogOut size={14} color="var(--text-secondary)" />
                Leave
              </button>
            )}
            <button
              onClick={handleShare}
              className="btn btn-outline"
              style={{ padding: '8px 14px', fontSize: '12px', gap: '6px', borderRadius: 'var(--radius-sm)' }}
              aria-label="Copy shareable connection link"
            >
              {copied ? <Check size={14} color="var(--accent)" /> : <Share2 size={14} color="var(--text-secondary)" />}
              {copied ? 'Copied!' : 'Share Connection'}
            </button>
          </div>
        </div>
      </header>

      {/* Manual-copy fallback when both clipboard paths fail */}
      {manualCopyUrl && (
        <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '8px 24px 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <div style={{ background: 'rgba(7,9,19,0.9)', border: '1px solid var(--border-glow)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            Clipboard unavailable — copy this link manually:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>{manualCopyUrl}</strong>
          </div>
        </div>
      )}

      {/* Main dashboard body */}
      <main className="app-container">
        {/* Invitee join panel */}
        {sessionState === 'joining' && urlSessionId && !sm && (
          <section className="glass-panel" style={{ borderColor: 'var(--border-glow)' }}>
            <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>
              You've been invited to a live session
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
              Set your name and location in the <strong style={{ color: 'var(--text-primary)' }}>Remote Node (User B)</strong>{' '}
              panel below — that is your identity in this session — then join. You will connect directly
              to the other person over the shared channel.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={handleJoin} className="btn btn-primary" style={{ gap: '8px' }}>
                Join Session
              </button>
              <button onClick={handleLeave} className="btn btn-outline">
                Cancel
              </button>
            </div>
          </section>
        )}

        {/* Session error panel */}
        {sessionState === 'error' && (
          <section className="glass-panel" style={{ borderColor: 'rgba(248, 113, 113, 0.4)' }}>
            <h2 style={{ fontSize: '20px', marginBottom: '8px', color: '#fca5a5' }}>
              Session unavailable
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
              {sessionError ?? 'Could not connect to this session.'}
            </p>
            <button onClick={handleLeave} className="btn btn-outline">
              Leave session
            </button>
          </section>
        )}

        {/* Intro Hero Section */}
        <section
          style={{
            textAlign: 'center',
            padding: '40px 20px',
            borderRadius: 'var(--radius-lg)',
            background: 'radial-gradient(ellipse at center, rgba(99, 102, 241, 0.08) 0%, transparent 70%)',
            border: '1px solid rgba(255, 255, 255, 0.02)'
          }}
        >
          <h2 style={{ fontSize: '32px', fontWeight: 800, letterSpacing: '-0.03em', marginBottom: '12px' }}>
            Distance is not a place. It's a <span style={{ color: 'var(--primary)' }}>clock</span>.
          </h2>
          <p style={{ maxWidth: '600px', margin: '0 auto', fontSize: '15px' }}>
            Orbit turns the delay, the distance, and the timezone between two people into a live, measurable window — and helps you spend it together before it ends.
          </p>
        </section>

        {/* Node Location Configurations */}
        <section className="dashboard-grid">
          <LocationSelector
            label="Host Terminal (User A)"
            userName={userNameA}
            setUserName={setOwnNameA}
            selectedCity={selectedCityA}
            onCitySelect={setOwnCityA}
            colorTheme="primary"
            disabled={myRole === 'b'}
          />

          <LocationSelector
            label="Remote Node (User B)"
            userName={userNameB}
            setUserName={setOwnNameB}
            selectedCity={selectedCityB}
            onCitySelect={setOwnCityB}
            colorTheme="secondary"
            disabled={myRole === 'a'}
          />
        </section>

        {/* Distance Display Curvature */}
        <section>
          <DistanceVisualizer
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
          />
        </section>

        {/* Our live window: shared awake-time stat + countdown + CTA */}
        <section>
          <LiveWindow
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
            sync={sync}
            hasPeer={hasRemotePeer}
          />
        </section>

        {/* Ping the light: measured round-trip (WebSocket in a session) */}
        <section>
          <PingMeter sync={sync} sessionManager={sm} hasPeer={hasRemotePeer} />
        </section>

        {/* Time Zone Syncing & Overlaps */}
        <section className="dashboard-grid">
          <TimezoneSync
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
          />

          <ChatBox
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
            sync={sync}
            sessionManager={sm}
            hasPeer={hasRemotePeer}
          />
        </section>

        {/* Shared Activity Center */}
        <section>
          {/**
           * Key by session identity so activity state (timer, canvas, cinema)
           * starts fresh when the session changes — leaving a session with a
           * running timer must not leave the next session's Start button
           * disabled by a phantom countdown. A reconnect keeps the same
           * sessionId, so mid-session state is preserved.
           */}
          <ActivityFinder
            key={sm?.sessionId ?? 'local'}
            nameA={userNameA}
            nameB={userNameB}
            sync={sync}
            sessionManager={sm}
            hasPeer={hasRemotePeer}
            remoteSession={sessionState !== 'local'}
          />
        </section>
      </main>

      {/* Footer */}
      <footer
        style={{
          borderTop: '1px solid var(--border-glass)',
          padding: '24px 0',
          marginTop: 'auto',
          background: 'rgba(0,0,0,0.2)',
          textAlign: 'center',
          fontSize: '13px',
          color: 'var(--text-muted)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
          <span>Orbit</span>
          <span>•</span>
          <span>Round 2 Transformation</span>
          <span>•</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
            Made with <Heart size={12} color="var(--secondary)" /> for Far Away
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
