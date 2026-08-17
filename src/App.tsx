import { useCallback, useEffect, useRef, useState } from 'react';
import { LocationSelector } from './components/LocationSelector';
import { TimezoneSync } from './components/TimezoneSync';
import { LiveWindow } from './components/LiveWindow';
import { PingMeter } from './components/PingMeter';
import { ActivityFinder, type ActivityLaunch } from './components/ActivityFinder';
import { SharedMoment, type MomentLaunch } from './components/SharedMoment';
import { ChatBox } from './components/ChatBox';
import { Heart, Share2, Check, LogOut } from 'lucide-react';
import { FALLBACK_CITIES, type CityData } from './lib/cities';
import { buildShareUrl, isValidConnectionState, parseShareUrl, type ConnectionState } from './lib/share';
import { OrbitSync } from './lib/broadcast';
import { clearSession, loadSession, persistSession, type ClientSession } from './lib/session';
import { createConnection, type Connection } from './lib/connection';
import {
  ApiError,
  createSession,
  joinSession,
  joinSessionByCode,
  leaveSession
} from './lib/api';
import { identityFromParts, otherPeers, peerIdentity, type ServerPeer } from './lib/reconcile';

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
const CODE_PARAM = 'code';

function parseSessionParam(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.get(SESSION_PARAM);
}

function parseCodeParam(search: string): string | null {
  const params = new URLSearchParams(search);
  return params.get(CODE_PARAM);
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
  // First-run hero: inline "Join with code" form state.
  const [heroJoinOpen, setHeroJoinOpen] = useState(false);
  const [heroCode, setHeroCode] = useState('');
  const copyTimerRef = useRef<number | null>(null);
  // Shared Moment → activity launch (Start Together). Consumed once by
  // ActivityFinder; chat launches scroll to the conversation instead.
  const [launchRequest, setLaunchRequest] = useState<ActivityLaunch | null>(null);

  // Live-tab sync: one OrbitSync for the app lifetime. It must run in EVERY
  // mode (local two-tab mode, and as an idle fallback during a session) so the
  // BroadcastChannel is always available when the UI is in local mode.
  const [sync] = useState(() => new OrbitSync());
  const [hasRemotePeer, setHasRemotePeer] = useState(false);

  const [urlSessionId] = useState(() => parseSessionParam(window.location.search));
  const [urlCode] = useState(() => parseCodeParam(window.location.search));
  const [persistedSession] = useState(loadSession);
  const [sessionState, setSessionState] = useState<SessionState>(() => {
    if (urlSessionId || urlCode) return 'joining';
    if (persistedSession) return 'joining';
    return 'local';
  });
  const [sessionError, setSessionError] = useState<string | null>(null);
  // A connection always exists: local (BroadcastChannel) by default, remote
  // (WebSocket) while a server session is active. Session selection happens
  // exactly here — createConnection(sync, session).
  const [connection, setConnection] = useState<Connection>(() =>
    createConnection(
      sync,
      // An open invite (UUID or code) takes precedence: a code invite cannot be
      // matched to a persisted session yet, so joining a new session must not
      // silently reuse a stale persisted one.
      persistedSession &&
        !urlCode &&
        (!urlSessionId || persistedSession.sessionId === urlSessionId)
        ? persistedSession
        : null
    )
  );
  const connectionRef = useRef<Connection>(connection);
  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);
  // The joined server session (remote only); local mode has none.
  const [session, setSession] = useState<ClientSession | null>(() =>
    persistedSession &&
      !urlCode &&
      (!urlSessionId || persistedSession.sessionId === urlSessionId)
      ? persistedSession
      : null
  );
  // Mirror for callbacks that must read the session without re-subscribing.
  const sessionRef = useRef<ClientSession | null>(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  // While an invite URL is open the role is unknown until the join response;
  // a stale persisted role from a different session must not apply.
  const [myRole, setMyRole] = useState<'a' | 'b' | null>(() => {
    if (urlSessionId || urlCode) return null;
    return persistedSession?.role ?? null;
  });

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
  const pendingIdentityRef = useRef<{ role: 'a' | 'b'; name: string; city: CityData } | null>(null);
  const scheduleIdentityPush = useCallback((role: 'a' | 'b', name: string, city: CityData) => {
    pendingIdentityRef.current = { role, name, city };
    if (identityTimerRef.current !== null) window.clearTimeout(identityTimerRef.current);
    identityTimerRef.current = window.setTimeout(() => {
      identityTimerRef.current = null;
      const pending = pendingIdentityRef.current;
      if (!pending) return;
      // Identity is server-authoritative in a remote session; in local mode
      // identities travel via the connection messages instead.
      const conn = connectionRef.current;
      if (!conn || conn.mode !== 'remote' || conn.role !== pending.role) return;
      conn.send('identity-update', {
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

  // Wire the active connection once per connection change: status drives the
  // session UI (remote only — local mode never leaves 'local'), peer presence
  // stays distinct from connection status, and remote-peer identity comes from
  // the state/peer-joined/peer-updated envelopes.
  useEffect(() => {
    connectionRef.current = connection;

    const unsubPeer = connection.onPeerChange((hasPeer) => setHasRemotePeer(hasPeer));

    if (connection.mode === 'remote') {
      const unsubStatus = connection.onStatus((status) => {
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
      const myPeerId = session?.peerId ?? '';
      // Persist the catch-up position as session metadata so a reconnect
      // resumes replay from this device's last applied event.
      const unsubSeq = connection.onSeqChange((seq) => {
        const current = sessionRef.current;
        if (current) persistSession({ ...current, lastAppliedEventSeq: seq });
      });
      const unsubEvent = connection.onEvent((env) => {
        if (env.event === 'state') {
          // State catch-up identifies the peer but does NOT set live presence:
          // a peer that has joined (database membership) may not have its
          // socket up. Presence comes from the connection's peer events.
          const others = otherPeers(env.payload.peers, myPeerId);
          for (const peer of others) applyPeerIdentity(peer);
        } else if (env.event === 'peer-joined') {
          // Never treat our own identity (a duplicate tab) as a remote peer.
          if (env.payload.peerId !== myPeerId) {
            const identity = identityFromParts(env.payload.displayName ?? '', env.payload.cityJson ?? '');
            if (identity) applyIdentity(connection.role === 'a' ? 'b' : 'a', identity);
          }
        } else if (env.event === 'peer-updated') {
          if (env.payload.peerId !== myPeerId) {
            const identity = identityFromParts(env.payload.displayName ?? '', env.payload.cityJson ?? '');
            if (identity) applyIdentity(connection.role === 'a' ? 'b' : 'a', identity);
          }
        }
      });
      connection.start();
      return () => {
        unsubStatus();
        unsubEvent();
        unsubPeer();
        unsubSeq();
        connection.stop();
      };
    }

    connection.start();
    return () => {
      unsubPeer();
      connection.stop();
    };
  }, [connection, session, applyIdentity, applyPeerIdentity]);

  // Strip the invite param after a reload that reconnects to the same
  // persisted session, so the next reload reconnects instead of re-joining.
  useEffect(() => {
    if (urlSessionId && persistedSession?.sessionId === urlSessionId) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [urlSessionId, persistedSession]);

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

  // Share the human-friendly code when we have one; legacy persisted sessions
  // without a code fall back to the UUID link (both invite forms are accepted).
  const sessionShareUrl = (s: ClientSession) =>
    s.code
      ? `${window.location.origin}${window.location.pathname}?code=${encodeURIComponent(s.code)}`
      : `${window.location.origin}${window.location.pathname}?session=${s.sessionId}`;

  const handleShare = async () => {
    if (sessionState === 'local') {
      try {
        setSessionState('joining');
        const { id, code } = await createSession();
        const res = await joinSession(id, userNameA || 'User A', selectedCityA);
        const newSession: ClientSession = {
          sessionId: id,
          peerId: res.peerId,
          role: res.role,
          token: res.token,
          code
        };
        persistSession(newSession);
        setMyRole(newSession.role);
        setSession(newSession);
        setLaunchRequest(null);
        setConnection(createConnection(sync, newSession));
        await copyToClipboard(sessionShareUrl(newSession));
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
      if (session) await copyToClipboard(sessionShareUrl(session));
    }
  };

  // Hero "Join with code": navigate to the code invite — the existing join
  // flow (detect param → joining state → join endpoint) takes over from there.
  const handleHeroJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const code = heroCode.trim();
    if (!code) return;
    window.location.href = `${window.location.pathname}?code=${encodeURIComponent(code)}`;
  };

  // Invitee join: User B opens ?session=<id> or ?code=<code>, enters identity,
  // joins, connects. Joining via code returns the session id so the persisted
  // session and reconnect use the UUID internally.
  const handleJoin = async () => {
    if (!urlSessionId && !urlCode) return;
    setSessionError(null);
    try {
      const res = urlCode
        ? await joinSessionByCode(urlCode, userNameB || 'User B', selectedCityB)
        : await joinSession(urlSessionId!, userNameB || 'User B', selectedCityB);
      const sessionId = urlCode ? res.sessionId! : urlSessionId!;
      const newSession: ClientSession = {
        sessionId,
        peerId: res.peerId,
        role: res.role,
        token: res.token,
        code: urlCode ?? undefined
      };
      persistSession(newSession);
      // Strip the invite param so a reload reconnects via the persisted
      // session instead of re-joining (which would answer 409 session full).
      window.history.replaceState(null, '', window.location.pathname);
      setMyRole(newSession.role);
      setSession(newSession);
      setLaunchRequest(null);
      setConnection(createConnection(sync, newSession));
    } catch (err) {
      setSessionState('error');
      setSessionError(friendlySessionError(err));
    }
  };

  // Shared Moment's Start Together: chat scrolls to the conversation, every
  // other activity runs through the existing realtime system via ActivityFinder.
  const handleMomentLaunch = useCallback((launch: MomentLaunch) => {
    if (launch.type === 'chat') {
      document.getElementById('chat-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setLaunchRequest({
      type: launch.type,
      durationMin: launch.durationMin,
      nonce: Date.now()
    });
  }, []);

  // Leave: stop the remote connection, clear session state, return to local
  // mode. Local names/cities and other app data are untouched.
  const handleLeave = async () => {
    if (session) {
      try {
        await leaveSession(session.sessionId, session.peerId, session.token);
      } catch {
        // Best effort — local cleanup proceeds regardless.
      }
    }
    // Silence the dying connection synchronously, BEFORE the state changes:
    // the server kicks the socket during leave, and its close event can land
    // after 'local' is committed but before React's passive cleanup runs.
    // RemoteConnection.stop() makes a stopped connection permanently silent,
    // so a late close can never override the local-mode state below.
    connectionRef.current?.stop();
    if (identityTimerRef.current !== null) window.clearTimeout(identityTimerRef.current);
    identityTimerRef.current = null;
    pendingIdentityRef.current = null;
    clearSession();
    setSession(null);
    setMyRole(null);
    setHasRemotePeer(false);
    setSessionError(null);
    setLaunchRequest(null);
    setSessionState('local');
    // Back to the BroadcastChannel transport; the wiring effect stops the
    // old remote connection and starts this one.
    setConnection(createConnection(sync, null));
    if (urlSessionId) window.history.replaceState(null, '', window.location.pathname);
  };

  // Calm, human status vocabulary. The transport may be a WebSocket —
  // the user only ever needs to know what it means for the two of them.
  const sessionStatusLabel: Record<SessionState, string> = {
    local: 'Local',
    joining: 'Joining…',
    connected: hasRemotePeer ? 'Connected · your person is online' : 'Connected · waiting for your person',
    reconnecting: 'Reconnecting…',
    disconnected: 'Connection lost',
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
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {/* Header — quiet wordmark, live status, two actions */}
      <header className="app-header">
        <div className="app-header-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', minWidth: 0 }}>
            <h1 className="wordmark">Orbit</h1>
            <span
              className="badge"
              style={{
                borderColor: statusColor,
                color: statusColor,
                animation:
                  sessionState === 'joining' || sessionState === 'reconnecting'
                    ? 'pulse-soft 1.6s ease-in-out infinite'
                    : 'none'
              }}
              aria-live="polite"
            >
              <span className="status-dot" style={{ background: statusColor }} />
              {sessionStatusLabel[sessionState]}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {sessionState !== 'local' && (
              <button
                onClick={handleLeave}
                className="btn btn-outline"
                style={{ padding: '7px 12px', fontSize: '13px', gap: '6px' }}
                aria-label="Leave the current session and return to local mode"
              >
                <LogOut size={14} />
                <span className="btn-text">Leave</span>
              </button>
            )}
            <button
              onClick={handleShare}
              className="btn btn-primary"
              style={{ padding: '7px 12px', fontSize: '13px', gap: '6px' }}
              aria-label="Copy shareable connection link"
            >
              {copied ? <Check size={14} /> : <Share2 size={14} />}
              <span className="btn-text">{copied ? 'Copied!' : 'Share Connection'}</span>
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
      <main className="app-container" id="main">
        {/* First-run hero — the product idea in one line, two actions.
            Only in local mode; sessions and joins show their own surfaces. */}
        {sessionState === 'local' && (
          <section className="hero" aria-label="Get started with Orbit">
            <h2 className="hero-title">Two places. One moment.</h2>
            <p className="hero-sub">
              Distance doesn't just separate people. It gives them different moments.
              Orbit makes those moments shared.
            </p>
            <div className="hero-actions">
              <button onClick={handleShare} className="btn btn-primary">
                Create a connection
              </button>
              {heroJoinOpen ? (
                <form className="hero-join" onSubmit={handleHeroJoin}>
                  <input
                    autoFocus
                    value={heroCode}
                    onChange={(e) => setHeroCode(e.target.value)}
                    placeholder="6-character code"
                    aria-label="Session code"
                    autoCapitalize="characters"
                  />
                  <button type="submit" className="btn btn-outline">
                    Join
                  </button>
                </form>
              ) : (
                <button onClick={() => setHeroJoinOpen(true)} className="btn btn-outline">
                  Join with code
                </button>
              )}
            </div>
          </section>
        )}

        {/* Invitee join panel */}
        {sessionState === 'joining' &&
          (urlSessionId || urlCode) &&
          connection.mode === 'local' && (
          <section className="glass-panel" style={{ borderColor: 'var(--border-glow)' }}>
            <h2 style={{ fontSize: '20px', marginBottom: '8px' }}>
              You've been invited to a live session
            </h2>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '14px' }}>
              Set your name and location in the <strong style={{ color: 'var(--text-primary)' }}>Person B</strong>{' '}
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

        {/* Node identity — the quiet plumbing. Two people, two places;
            editable by whoever owns each side. */}
        <section className="dashboard-grid" aria-label="Participants">
          <LocationSelector
            label="Person A"
            userName={userNameA}
            setUserName={setOwnNameA}
            selectedCity={selectedCityA}
            onCitySelect={setOwnCityA}
            colorTheme="primary"
            disabled={myRole === 'b'}
          />

          <LocationSelector
            label="Person B"
            userName={userNameB}
            setUserName={setOwnNameB}
            selectedCity={selectedCityB}
            onCitySelect={setOwnCityB}
            colorTheme="secondary"
            disabled={myRole === 'a'}
          />
        </section>

        {/* Our live window: the shared-time signature — each person's
            local time, the overlap between them, and the live countdown. */}
        <section>
          <LiveWindow
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
            hasPeer={hasRemotePeer}
            role={myRole}
          />
        </section>

        {/* Shared Moment: deterministic facts + recommended activity to do
            together, launched through the existing realtime system. Keyed by
            session so the recommendation and started-state reset on leave. */}
        <section>
          <SharedMoment
            key={session?.sessionId ?? 'local'}
            cityA={selectedCityA}
            cityB={selectedCityB}
            nameA={userNameA}
            nameB={userNameB}
            hasPeer={hasRemotePeer}
            sessionKey={session?.sessionId ?? 'local'}
            session={session ? { sessionId: session.sessionId, peerId: session.peerId } : null}
            onLaunch={handleMomentLaunch}
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
            key={session?.sessionId ?? 'local'}
            nameA={userNameA}
            nameB={userNameB}
            connection={connection}
            hasPeer={hasRemotePeer}
            launchRequest={launchRequest}
          />
        </section>

        {/* Time planning and the conversation — the two everyday tools. */}
        <section className="dashboard-grid" aria-label="Time and conversation">
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
            connection={connection}
            hasPeer={hasRemotePeer}
            myPeerId={session?.peerId ?? ''}
          />
        </section>

        {/* The measured line — one quiet footer fact about the link itself. */}
        <section aria-label="Connection quality">
          <PingMeter connection={connection} hasPeer={hasRemotePeer} />
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span>Orbit</span>
          <span>•</span>
          <span>Shared moments, even when you're far apart</span>
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
