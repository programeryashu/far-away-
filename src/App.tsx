import { useEffect, useRef, useState } from 'react';
import { LocationSelector } from './components/LocationSelector';
import { DistanceVisualizer } from './components/DistanceVisualizer';
import { TimezoneSync } from './components/TimezoneSync';
import { LiveWindow } from './components/LiveWindow';
import { PingMeter } from './components/PingMeter';
import { ActivityFinder } from './components/ActivityFinder';
import { ChatBox } from './components/ChatBox';
import { Globe, Heart, Share2, Check } from 'lucide-react';
import { FALLBACK_CITIES, type CityData } from './lib/cities';
import { buildShareUrl, isValidConnectionState, parseShareUrl, type ConnectionState } from './lib/share';
import { OrbitSync } from './lib/broadcast';

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

function App() {
  const [initial] = useState(loadInitialState);
  const [userNameA, setUserNameA] = useState(initial.a.name);
  const [selectedCityA, setSelectedCityA] = useState<CityData>(initial.a.city);
  const [userNameB, setUserNameB] = useState(initial.b.name);
  const [selectedCityB, setSelectedCityB] = useState<CityData>(initial.b.city);
  const [copied, setCopied] = useState(false);
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Live-tab sync (Feature A): one OrbitSync for the app lifetime. Host owns
  // side A, the remote tab owns side B; each peer merges only its own side.
  const [sync] = useState(() => new OrbitSync());
  const [hasPeer, setHasPeer] = useState(false);

  // Persist the connection whenever any of the four values change
  useEffect(() => {
    const state: ConnectionState = {
      a: { name: userNameA, city: selectedCityA },
      b: { name: userNameB, city: selectedCityB }
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage may be unavailable (private mode / quota) — ignore
    }
  }, [userNameA, selectedCityA, userNameB, selectedCityB]);

  // Once consumed, drop share-link params so reloads use localStorage
  useEffect(() => {
    if (window.location.search) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  // Start the channel, follow peer presence, and merge the peer's name and
  // city into the side this tab does not own (host owns A, remote owns B).
  useEffect(() => {
    sync.start();
    const offPeers = sync.onPeersChange(setHasPeer);
    const offMessages = sync.onMessage((msg) => {
      if (msg.type === 'names') {
        if (sync.side === 'host') setUserNameB(msg.nameB);
        else setUserNameA(msg.nameA);
      } else if (msg.type === 'connection') {
        if (sync.side === 'host') setSelectedCityB(msg.payload.b.city);
        else setSelectedCityA(msg.payload.a.city);
      }
    });
    return () => {
      offPeers();
      offMessages();
      sync.dispose();
    };
  }, [sync]);

  // Broadcast the full connection whenever either person's name or city
  // changes; a peer merges only its own side and ignores the rest.
  useEffect(() => {
    sync.sendNames(userNameA, userNameB);
    sync.sendConnection({
      a: { name: userNameA, city: selectedCityA },
      b: { name: userNameB, city: selectedCityB }
    });
  }, [sync, userNameA, userNameB, selectedCityA, selectedCityB]);

  const handleShare = async () => {
    const url = buildShareUrl({
      a: { name: userNameA, city: selectedCityA },
      b: { name: userNameB, city: selectedCityB }
    });
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
                Far Away Connection Hub
              </h1>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Bridging space & time across orbits
              </p>
            </div>
          </div>

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
            How Far Is <span style={{ color: 'var(--primary)' }}>Far Away</span>?
          </h2>
          <p style={{ maxWidth: '600px', margin: '0 auto', fontSize: '15px' }}>
            Enter your locations below to compute distances, synchronize local day timelines, chat with low-latency route trace, and run synchronized video & sketch session mockups.
          </p>
        </section>

        {/* Node Location Configurations */}
        <section className="dashboard-grid">
          <LocationSelector
            label="Host Terminal (User A)"
            userName={userNameA}
            setUserName={setUserNameA}
            selectedCity={selectedCityA}
            onCitySelect={setSelectedCityA}
            colorTheme="primary"
          />

          <LocationSelector
            label="Remote Node (User B)"
            userName={userNameB}
            setUserName={setUserNameB}
            selectedCity={selectedCityB}
            onCitySelect={setSelectedCityB}
            colorTheme="secondary"
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
            hasPeer={hasPeer}
          />
        </section>

        {/* Ping the light: measured BroadcastChannel round-trip */}
        <section>
          <PingMeter sync={sync} hasPeer={hasPeer} />
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
            hasPeer={hasPeer}
          />
        </section>

        {/* Shared Activity Center */}
        <section>
          <ActivityFinder
            nameA={userNameA}
            nameB={userNameB}
            sync={sync}
            hasPeer={hasPeer}
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
          <span>Far Away Connection Hub</span>
          <span>•</span>
          <span>Hackathon MVP</span>
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
