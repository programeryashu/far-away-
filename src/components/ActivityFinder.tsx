import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Video, Paintbrush, Coffee, CloudRain, Play, Pause, RotateCcw, X, Users } from 'lucide-react';
import type { TimerPayload } from '../lib/broadcast';
import type { Connection } from '../lib/connection';
import { parseCanvasStrokes, parseCinemaState, parseTimerState } from '../lib/reconcile';
import { CINEMA_EVENT, type CinemaPayload } from '../../shared/protocol';

/**
 * A shared-activity launch command, e.g. from Shared Moment's Start Together.
 * The launched activity runs through the exact same canonical path as the UI
 * buttons — one realtime send, same persistence/replay semantics.
 */
export interface ActivityLaunch {
  type: 'timer' | 'cinema' | 'canvas';
  durationMin?: number;
  /** Monotonic marker so the same command is consumed exactly once. */
  nonce: number;
}

interface ActivityFinderProps {
  nameA: string;
  nameB: string;
  /** Active transport (BroadcastChannel locally, WebSocket in a session). */
  connection: Connection;
  /** True when a second peer is connected right now. */
  hasPeer: boolean;
  /** Pending shared-activity launch (Start Together); consumed once. */
  launchRequest?: ActivityLaunch | null;
}

interface Activity {
  id: string;
  title: string;
  desc: string;
  icon: React.ReactNode;
}

interface Point {
  x: number;
  y: number;
}

interface Stroke {
  points: Point[];
  color: string;
}

const FOCUS_SECONDS = 25 * 60;
const USER_COLOR = 'rgba(99, 102, 241, 0.8)';
const PARTNER_COLOR = 'rgba(236, 72, 153, 0.8)';

const formatTime = (totalSeconds: number) => {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const drawStroke = (ctx: CanvasRenderingContext2D, stroke: Stroke) => {
  if (stroke.points.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (let i = 1; i < stroke.points.length; i++) {
    ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
  }
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.stroke();
};

const sampleBezier = (p0: Point, p1: Point, p2: Point, p3: Point, steps = 24): Point[] => {
  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    points.push({
      x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
      y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
    });
  }
  return points;
};

// Build the partner heart as two strokes so it replays correctly after resize
const buildHeartStrokes = (cx: number, cy: number): Stroke[] => {
  const left = sampleBezier({ x: cx, y: cy }, { x: cx - 20, y: cy - 20 }, { x: cx - 40, y: cy + 10 }, { x: cx, y: cy + 40 });
  const right = sampleBezier({ x: cx, y: cy }, { x: cx + 20, y: cy - 20 }, { x: cx + 40, y: cy + 10 }, { x: cx, y: cy + 40 });
  return [
    { points: left, color: PARTNER_COLOR },
    { points: right, color: PARTNER_COLOR }
  ];
};

export const ActivityFinder: React.FC<ActivityFinderProps> = ({
  nameA,
  nameB,
  connection,
  hasPeer,
  launchRequest = null
}) => {
  const [activeModal, setActiveModal] = useState<string | null>(null);

  // Which side is "mine": the connection knows (tab side locally, server
  // role in a session — A = indigo, B = pink). This drives whose strokes are
  // "mine" and which names appear in the shared logs.
  const ownIsA = connection.role === 'a';
  const ownName = ownIsA ? nameA || 'User A' : nameB || 'User B';
  const peerName = ownIsA ? nameB || 'User B' : nameA || 'User A';
  const myColor = ownIsA ? USER_COLOR : PARTNER_COLOR;
  const peerColor = ownIsA ? PARTNER_COLOR : USER_COLOR;

  // Names can change; keep a live copy the channel handler can read without
  // re-subscribing on every keystroke. Refreshed in an effect (never during
  // render) so the handler always sees the latest names/colors.
  const liveRef = useRef({ peerName, peerColor });
  useEffect(() => {
    liveRef.current = { peerName, peerColor };
  }, [peerName, peerColor]);

  // SynchroCinema State
  const [isPlaying, setIsPlaying] = useState(false);
  const [syncStatus, setSyncStatus] = useState('Synced');
  const [cinemaLogs, setCinemaLogs] = useState<string[]>(['Session initialized']);

  // Deep Space Coffee Timer State
  const [secondsLeft, setSecondsLeft] = useState(FOCUS_SECONDS);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionLogs, setSessionLogs] = useState<string[]>([]);
  const endAtRef = useRef<number>(0);

  // Canvas State
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [canvasLogs, setCanvasLogs] = useState<string[]>([]);
  const [partnerDrawing, setPartnerDrawing] = useState(false);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const partnerDrawTimerRef = useRef<number | null>(null);
  const cinemaTimerRef = useRef<number | null>(null);

  // Pomodoro countdown anchored to the wall clock, so background-tab throttling
  // of setInterval can't make the shared timer drift. Uses new Date().getTime()
  // (not Date.now()) to satisfy react-compiler purity rules; all setState happens
  // inside the async interval callback.
  useEffect(() => {
    if (!isRunning) return;
    const interval = window.setInterval(() => {
      const remaining = Math.max(0, Math.round((endAtRef.current - new Date().getTime()) / 1000));
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        setIsRunning(false);
        setSessionLogs(prev => ['Session complete — take a break.', ...prev]);
      }
    }, 250);
    return () => window.clearInterval(interval);
  }, [isRunning]);

  const sendTimer = useCallback((payload: TimerPayload) => {
    connection.send('timer', payload);
  }, [connection]);

  // Start the shared countdown from an explicit duration (used by Start
  // Together) or from the current position; always exactly one send, the same
  // canonical path as the Start button.
  const startTimerWithSeconds = useCallback((totalSeconds: number) => {
    const now = new Date().getTime();
    endAtRef.current = now + totalSeconds * 1000;
    setSecondsLeft(Math.max(0, Math.round((endAtRef.current - now) / 1000)));
    setIsRunning(true);
    sendTimer({ action: 'start', endAt: endAtRef.current, remaining: 0 });
  }, [sendTimer]);

  const handleStartTimer = () => {
    startTimerWithSeconds(secondsLeft <= 0 ? FOCUS_SECONDS : secondsLeft);
  };

  const handlePauseTimer = () => {
    const remaining = Math.max(0, Math.round((endAtRef.current - new Date().getTime()) / 1000));
    setSecondsLeft(remaining);
    setIsRunning(false);
    sendTimer({ action: 'pause', endAt: 0, remaining });
  };

  const handleResetTimer = () => {
    setIsRunning(false);
    endAtRef.current = 0;
    setSecondsLeft(FOCUS_SECONDS);
    sendTimer({ action: 'reset', endAt: 0, remaining: FOCUS_SECONDS });
  };

  // ------------------------------------
  // Cinema Simulation logic
  // ------------------------------------
  // Single play/pause path: the toggle flips, Start Together forces play.
  const applyCinemaPlaying = useCallback((playing: boolean) => {
    setIsPlaying(playing);
    setSyncStatus('Syncing…');

    // Add user action log
    const userLog = `${ownName} ${playing ? 'pressed PLAY' : 'pressed PAUSE'}`;
    setCinemaLogs(prev => [userLog, ...prev]);

    // A real peer mirrors the toggle over the active transport.
    connection.send(CINEMA_EVENT, { playing } satisfies CinemaPayload);

    cinemaTimerRef.current = window.setTimeout(() => {
      setSyncStatus('Synced');
      if (!hasPeer) {
        const partnerLog = `${peerName} synced to playback at 02:45`;
        setCinemaLogs(prev => [partnerLog, ...prev]);
      }
    }, 1000);
  }, [ownName, connection, hasPeer, peerName]);

  const handleCinemaToggle = () => {
    applyCinemaPlaying(!isPlaying);
  };

  // ------------------------------------
  // Canvas Drawing logic (DPR-aware)
  // ------------------------------------
  const getCanvasPoint = (e: React.MouseEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const redrawAll = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    // Work in CSS pixel coordinates; the transform maps them to physical pixels
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    strokesRef.current.forEach(stroke => drawStroke(ctx, stroke));
    // Replay the in-progress stroke too, so a resize mid-drag doesn't wipe it
    const current = currentStrokeRef.current;
    if (current && current.points.length > 0) drawStroke(ctx, current);
  }, []);

  // Apply an inbound shared-timer update (wall-clock anchored) from either
  // transport.
  const applyTimer = useCallback((payload: TimerPayload) => {
    if (payload.action === 'start') {
      endAtRef.current = payload.endAt;
      const remaining = Math.max(0, Math.round((payload.endAt - new Date().getTime()) / 1000));
      setSecondsLeft(remaining);
      // A persisted start whose deadline already passed must not spin up the
      // countdown as if it were live.
      setIsRunning(remaining > 0);
    } else if (payload.action === 'pause') {
      setSecondsLeft(payload.remaining);
      setIsRunning(false);
    } else if (payload.action === 'reset') {
      setIsRunning(false);
      endAtRef.current = 0;
      setSecondsLeft(FOCUS_SECONDS);
    }
  }, []);

  // Inbound activity events from a real peer. Remote sessions arrive over the
  // WebSocket; local two-tab mode over the BroadcastChannel. Both are
  // idempotent (canvas replaces/append strokes, never duplicates).
  useEffect(() => {
    // Both transports deliver the same typed envelopes, so this one handler
    // covers local and remote activity sync.
    return connection.onEvent((env) => {
      if (env.event === 'canvas-stroke') {
        strokesRef.current = [...strokesRef.current, env.payload];
        redrawAll();
      } else if (env.event === 'canvas-clear') {
        strokesRef.current = [];
        setCanvasLogs([]);
        redrawAll();
      } else if (env.event === 'timer') {
        applyTimer(env.payload);
      } else if (env.event === CINEMA_EVENT) {
        setIsPlaying(env.payload.playing);
        setSyncStatus('Synced');
        setCinemaLogs((prev) => [
          `${peerName} ${env.payload.playing ? 'pressed PLAY' : 'pressed PAUSE'}`,
          ...prev
        ]);
      } else if (env.event === 'state') {
        if (env.payload.canvas) {
          const strokes = parseCanvasStrokes(env.payload.canvas);
          if (strokes.length > 0 || strokesRef.current.length > 0) {
            strokesRef.current = strokes as Stroke[];
            redrawAll();
          }
        }
        const timer = parseTimerState(env.payload.timer);
        if (timer) applyTimer(timer);
        // Inherit an already-running shared watch: the snapshot is the only
        // way an afterSeq=0 joiner learns the cinema state (the event itself
        // is never replayed to it). No log line — no peer action happened.
        const cinema = parseCinemaState(env.payload.cinema);
        if (cinema) {
          setIsPlaying(cinema.playing);
          setSyncStatus('Synced');
        }
      }
    });
  }, [connection, redrawAll, applyTimer, peerName]);

  // One place that turns a launch into activity state. Stable so the launch
  // effect below only depends on the request itself.
  const performLaunch = useCallback(
    (launch: ActivityLaunch) => {
      if (launch.type === 'timer') {
        startTimerWithSeconds((launch.durationMin ?? 45) * 60);
        setActiveModal('cafe');
      } else if (launch.type === 'cinema') {
        applyCinemaPlaying(true);
        setActiveModal('cinema');
      } else if (launch.type === 'canvas') {
        setActiveModal('canvas');
      }
    },
    [startTimerWithSeconds, applyCinemaPlaying]
  );

  // Start Together: a launch command (from Shared Moment) opens the matching
  // activity and runs the exact same canonical action as the UI buttons — one
  // send, same persistence/replay path. The nonce guard makes consumption
  // idempotent across re-renders.
  const consumedLaunchRef = useRef<number | null>(null);
  useEffect(() => {
    if (!launchRequest) return;
    if (consumedLaunchRef.current === launchRequest.nonce) return;
    consumedLaunchRef.current = launchRequest.nonce;
    performLaunch(launchRequest);
  }, [launchRequest, performLaunch]);

  // Size the canvas bitmap to match its rendered CSS box on mount + resize
  useEffect(() => {
    if (activeModal !== 'canvas') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    redrawAll();
    const observer = new ResizeObserver(redrawAll);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [activeModal, redrawAll]);

  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const point = getCanvasPoint(e);
    if (!point) return;

    currentStrokeRef.current = { points: [point], color: myColor };
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.strokeStyle = myColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    setIsDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const point = getCanvasPoint(e);
    if (!point) return;

    currentStrokeRef.current?.points.push(point);
    ctx.lineTo(point.x, point.y);
    ctx.strokeStyle = myColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    if (stroke && stroke.points.length > 0) {
      strokesRef.current = [...strokesRef.current, stroke];
      // Ship the completed stroke to the real peer over the active transport.
      connection.send('canvas-stroke', stroke);
    }

    // Simulated partner drawing is the offline fallback for local solo mode
    // only — a real peer draws back over the active transport.
    if (!hasPeer && connection.mode === 'local' && canvasLogs.length === 0) {
      setPartnerDrawing(true);
      setCanvasLogs(prev => [`${nameB || 'User B'} is drawing…`, ...prev]);

      partnerDrawTimerRef.current = window.setTimeout(() => {
        strokesRef.current = [...strokesRef.current, ...buildHeartStrokes(250, 100)];
        redrawAll();
        setPartnerDrawing(false);
        setCanvasLogs(prev => [`${nameB || 'User B'} drew a heart`, ...prev]);
      }, 1500);
    }
  };

  const clearCanvas = () => {
    strokesRef.current = [];
    setCanvasLogs([]);
    redrawAll();
    connection.send('canvas-clear', {});
  };

  // Activity list
  const activities: Activity[] = [
    {
      id: 'cinema',
      title: 'SynchroCinema',
      desc: 'Watch together with synchronized playback and shared reaction logs.',
      icon: <Video size={18} color="var(--text-secondary)" />
    },
    {
      id: 'canvas',
      title: 'Galactic Canvas',
      desc: 'A shared whiteboard — sketch together and see strokes arrive live.',
      icon: <Paintbrush size={18} color="var(--text-secondary)" />
    },
    {
      id: 'cafe',
      title: 'Deep Space Coffee',
      desc: 'Ambient soundscape mixed with a shared focus timer.',
      icon: <Coffee size={18} color="var(--text-secondary)" />
    }
  ];

  return (
    <div id="activity-center" className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <h2 style={{ fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        Shared Activities
      </h2>
      <p style={{ fontSize: '14px' }}>
        Cinema, canvas, and a shared focus timer — synced between you.
      </p>

      {/* Activities Grid */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '10px' }}>
        {activities.map((act) => (
          <div
            key={act.id}
            style={{
              padding: '16px',
              borderRadius: 'var(--radius-md)',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-glass)',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              transition: 'var(--transition-smooth)'
            }}
          >
            <div className="flex-between">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {act.icon}
                <h4 style={{ fontSize: '15px' }}>{act.title}</h4>
              </div>
            </div>
            <p style={{ fontSize: '13px' }}>{act.desc}</p>
            <button
              onClick={() => setActiveModal(act.id)}
              className="btn btn-outline"
              style={{
                width: '100%',
                padding: '8px 16px',
                fontSize: '13px',
                marginTop: '4px'
              }}
            >
              Initialize Session
            </button>
          </div>
        ))}
      </div>

      {/* ---------------------------------------------------- */}
      {/* SynchroCinema Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cinema' && (
        <div className="modal-overlay">
          <div
            className="glass-panel modal-panel"
            style={{
              maxWidth: '600px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: 'var(--shadow-pop)'
            }}
          >
            <div className="flex-between">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Video size={20} color="var(--primary)" />
                SynchroCinema Control Center
              </h3>
              <button
                onClick={() => {
                  if (cinemaTimerRef.current !== null) window.clearTimeout(cinemaTimerRef.current);
                  setActiveModal(null);
                  setIsPlaying(false);
                }}
                className="modal-close"
                aria-label="Close SynchroCinema"
              >
                <X size={18} />
              </button>
            </div>

            {/* Video Player Mockup */}
            <div
              style={{
                width: '100%',
                height: '240px',
                background: '#04060f',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-glass)',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  backgroundImage: 'linear-gradient(to bottom, #111827, #030712)',
                  zIndex: 0
                }}
              ></div>

              <div style={{ zIndex: 2, textAlign: 'center' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>
                  Now streaming
                </span>
                <h4 style={{ fontSize: '18px', marginBottom: '16px' }}>Exploring the Far Reaches (Trailer)</h4>

                <button
                  onClick={handleCinemaToggle}
                  className="btn btn-primary"
                  style={{
                    borderRadius: '50%',
                    width: '60px',
                    height: '60px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0
                  }}
                  aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
                >
                  {isPlaying ? <Pause size={24} /> : <Play size={24} style={{ marginLeft: '4px' }} />}
                </button>
              </div>

              {/* Player bar */}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  padding: '12px',
                  background: 'rgba(0,0,0,0.6)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  zIndex: 2
                }}
              >
                <span style={{ fontSize: '11px', fontFamily: 'monospace' }}>02:45 / 03:00</span>
                <span style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Users size={12} /> Sync: <span style={{ color: 'var(--accent)' }}>{syncStatus}</span>
                </span>
              </div>
            </div>

            {/* Sync logs */}
            <div>
              <label>Connection Activity Logs</label>
              <div
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-sm)',
                  height: '100px',
                  overflowY: 'auto',
                  padding: '10px',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}
              >
                {cinemaLogs.map((log, idx) => (
                  <div key={idx} style={{ color: idx === 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                    &gt; {log}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- */}
      {/* Galactic Canvas Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'canvas' && (
        <div className="modal-overlay">
          <div
            className="glass-panel modal-panel"
            style={{
              maxWidth: '540px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: 'var(--shadow-pop)'
            }}
          >
            <div className="flex-between">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Paintbrush size={20} color="var(--secondary)" />
                Galactic Canvas Collaboration
              </h3>
              <button
                onClick={() => {
                  if (partnerDrawTimerRef.current !== null) window.clearTimeout(partnerDrawTimerRef.current);
                  setActiveModal(null);
                }}
                className="modal-close"
                aria-label="Close Galactic Canvas"
              >
                <X size={18} />
              </button>
            </div>

            {/* Drawing Board */}
            <div style={{ position: 'relative' }}>
              <canvas
                ref={canvasRef}
                onMouseDown={startDrawing}
                onMouseMove={draw}
                onMouseUp={stopDrawing}
                onMouseLeave={stopDrawing}
                style={{
                  background: '#04060f',
                  border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-md)',
                  width: '100%',
                  height: '260px',
                  cursor: 'crosshair',
                  display: 'block'
                }}
              />

              {partnerDrawing && (
                <div
                  style={{
                    position: 'absolute',
                    top: '12px',
                    left: '12px',
                    background: 'rgba(224,123,180,0.92)',
                    padding: '4px 10px',
                    borderRadius: '4px',
                    fontSize: '11px',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <Users size={10} /> {nameB || 'Partner'} is drawing…
                </div>
              )}
            </div>

            {/* Controls */}
            <div className="flex-between">
              <button onClick={clearCanvas} className="btn btn-outline" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <RotateCcw size={14} /> Clear Canvas
              </button>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Draw — strokes sync live.
              </div>
            </div>

            {/* Action Log */}
            <div
              style={{
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid var(--border-glass)',
                borderRadius: 'var(--radius-sm)',
                height: '60px',
                overflowY: 'auto',
                padding: '8px 12px',
                fontFamily: 'monospace',
                fontSize: '12px'
              }}
            >
              {canvasLogs.length > 0 ? (
                canvasLogs.map((log, idx) => (
                  <div key={idx} style={{ color: 'var(--text-secondary)' }}>
                    &gt; {log}
                  </div>
                ))
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>&gt; Awaiting initial brush stroke...</span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- */}
      {/* Deep Space Coffee Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cafe' && (
        <div className="modal-overlay">
          <div
            className="glass-panel modal-panel"
            style={{
              maxWidth: '440px',
              width: '100%',
              display: 'flex',
              flexDirection: 'column',
              gap: '16px',
              boxShadow: 'var(--shadow-pop)'
            }}
          >
            <div className="flex-between">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Coffee size={20} color="var(--accent)" />
                Deep Space Cafe & Focus Timer
              </h3>
              <button
                onClick={() => setActiveModal(null)}
                className="modal-close"
                aria-label="Close Deep Space Coffee"
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: '44px', fontWeight: 650, fontFamily: 'monospace', letterSpacing: '0.02em' }}>
                {formatTime(secondsLeft)}
              </div>
              <span style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'block', marginTop: '6px' }}>
                Shared focus session
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <label>Soundscape</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '9px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-glass)',
                    fontSize: '13px'
                  }}
                >
                  <Coffee size={14} color="var(--accent)" />
                  <span>Cosmic Cafe</span>
                  <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: '12px' }}>Active</span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '9px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-glass)',
                    fontSize: '13px',
                    color: 'var(--text-muted)'
                  }}
                >
                  <CloudRain size={14} />
                  <span>Solar Rain</span>
                  <span style={{ marginLeft: 'auto', fontSize: '12px' }}>Off</span>
                </div>
              </div>
            </div>

            {/* Timer controls */}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleStartTimer}
                disabled={isRunning}
                className="btn btn-primary"
                style={{ flex: 1, padding: '10px 16px', fontSize: '13px' }}
              >
                <Play size={14} /> Start
              </button>
              <button
                onClick={handlePauseTimer}
                disabled={!isRunning}
                className="btn btn-outline"
                style={{ flex: 1, padding: '10px 16px', fontSize: '13px' }}
              >
                <Pause size={14} /> Pause
              </button>
              <button
                onClick={handleResetTimer}
                className="btn btn-outline"
                style={{ flex: 1, padding: '10px 16px', fontSize: '13px' }}
              >
                <RotateCcw size={14} /> Reset
              </button>
            </div>

            {/* Session log */}
            <div>
              <label>Session Log</label>
              <div
                style={{
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--border-glass)',
                  borderRadius: 'var(--radius-sm)',
                  minHeight: '48px',
                  maxHeight: '96px',
                  overflowY: 'auto',
                  padding: '8px 12px',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px'
                }}
              >
                {sessionLogs.length > 0 ? (
                  sessionLogs.map((log, idx) => (
                    <div key={idx} style={{ color: idx === 0 ? 'var(--accent)' : 'var(--text-muted)' }}>
                      &gt; {log}
                    </div>
                  ))
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>&gt; No sessions completed yet.</span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
