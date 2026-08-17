import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Video,
  Paintbrush,
  Coffee,
  Play,
  Pause,
  RotateCcw,
  X,
  Users,
  Volume2,
  VolumeX,
  MessageCircle
} from 'lucide-react';
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
const USER_COLOR = 'rgba(217, 164, 65, 0.8)';
const PARTNER_COLOR = 'rgba(224, 123, 180, 0.8)';

/**
 * The shared watch's media: a short public-domain NASA clip (aurora over
 * Earth from the ISS), bundled with the app so the demo works offline and
 * nothing copyrighted is streamed.
 */
const CINEMA_VIDEO_SRC = '/cinema/aurora.mp4';

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

/**
 * Shared modal keyboard behavior: Escape closes, Tab stays inside the panel
 * (the overlay is the whole world while a dialog is open).
 */
const handleModalKeys = (e: React.KeyboardEvent<HTMLDivElement>, close: () => void) => {
  if (e.key === 'Escape') {
    close();
    return;
  }
  if (e.key !== 'Tab') return;
  const panel = e.currentTarget.querySelector<HTMLElement>('.modal-panel');
  if (!panel) return;
  const focusables = Array.from(
    panel.querySelectorAll<HTMLElement>('button, input, select, textarea, [href]')
  ).filter((el) => !(el as HTMLButtonElement | HTMLInputElement).disabled);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
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

  // ------------------------------------
  // Cinema — a real shared <video>
  // ------------------------------------
  // The shared state is { playing, position }: every action (play, pause,
  // seek) sends both, and the peer applies both, so two devices stay on the
  // same playback point. `cinemaStateRef` is the last known shared state —
  // it restores the video when the modal reopens and survives snapshots.
  const cinemaStateRef = useRef<{ playing: boolean; position: number; at: number }>({
    playing: false,
    position: 0,
    at: 0,
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoMuted, setVideoMuted] = useState(true);
  const [syncStatus, setSyncStatus] = useState('Synced');
  const [cinemaLogs, setCinemaLogs] = useState<string[]>(['Session initialized']);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cinemaTimerRef = useRef<number | null>(null);

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
  // Cinema playback sync logic
  // ------------------------------------
  // jsdom has no media playback; play()/pause() must never throw in tests.
  const safeVideoPlay = useCallback((video: HTMLVideoElement) => {
    try {
      const p = video.play() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => { /* autoplay blocked */ });
    } catch {
      // media playback not implemented — ignore
    }
  }, []);

  // Apply a shared playback state to the local video (when mounted) and
  // remember it so a reopened modal resumes from the same point. `at` is when
  // this state was true, so a restore can advance a still-playing position by
  // the wall-clock time elapsed since (the same anchoring as the snapshot).
  const applyCinemaState = useCallback(
    (playing: boolean, position: number) => {
      cinemaStateRef.current = { playing, position, at: Date.now() };
      setIsPlaying(playing);
      const video = videoRef.current;
      if (video) {
        // The clip loops, so a wall-clock-extrapolated position wraps into the
        // duration instead of dead-ending at the last frame.
        const target =
          videoDuration > 0 ? position % videoDuration : position;
        try {
          video.currentTime = Math.max(0, target);
        } catch {
          // setting currentTime before metadata is inert — safe to skip
        }
        if (playing) safeVideoPlay(video);
        else video.pause?.();
      }
    },
    [safeVideoPlay, videoDuration],
  );

  // Single outbound path: the toggle (and Start Together's forced play) both
  // land here. Position always travels with the play state so the peer
  // re-anchors to the exact playback point.
  const sendCinemaAction = useCallback(
    (playing: boolean, position: number, log: string) => {
      applyCinemaState(playing, position);
      setSyncStatus('Syncing…');
      setCinemaLogs(prev => [log, ...prev]);
      connection.send(CINEMA_EVENT, { playing, position } satisfies CinemaPayload);
      if (cinemaTimerRef.current !== null) window.clearTimeout(cinemaTimerRef.current);
      cinemaTimerRef.current = window.setTimeout(() => setSyncStatus('Synced'), 1000);
    },
    [applyCinemaState, connection],
  );

  const handleCinemaToggle = () => {
    const video = videoRef.current;
    const position = video ? video.currentTime : cinemaStateRef.current.position;
    sendCinemaAction(
      !isPlaying,
      position,
      `${ownName} ${!isPlaying ? 'pressed PLAY' : 'pressed PAUSE'} at ${formatTime(position)}`,
    );
  };

  const handleCinemaSeek = (value: number) => {
    sendCinemaAction(
      isPlaying,
      value,
      `${ownName} seeked to ${formatTime(value)}`,
    );
  };

  // ------------------------------------
  // Canvas drawing logic (DPR-aware, pointer events for touch/pen/mouse)
  // ------------------------------------
  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point | null => {
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
        const { playing, position } = env.payload;
        // The server echoes cinema events to the sender too (so the sender's
        // event-seq floor advances). Our own echo — or any action that would
        // not change the current state — is a no-op, never a re-anchor or a
        // log line; a real peer action differs in play state or position.
        const currentPos = videoRef.current
          ? videoRef.current.currentTime
          : cinemaStateRef.current.position;
        if (playing === isPlaying && Math.abs(position - currentPos) < 2) {
          setSyncStatus('Synced');
          return;
        }
        applyCinemaState(playing, position);
        setSyncStatus('Synced');
        setCinemaLogs((prev) => [
          `${peerName} ${playing ? 'pressed PLAY' : 'pressed PAUSE'} at ${formatTime(position)}`,
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
        // Inherit the shared watch's live playback point: the snapshot is the
        // only way an afterSeq=0 joiner learns the cinema state (the event
        // itself is never replayed to it). No log line — no peer action happened.
        const cinema = parseCinemaState(env.payload.cinema);
        if (cinema) {
          applyCinemaState(cinema.playing, cinema.position);
          setSyncStatus('Synced');
        }
      }
    });
  }, [connection, redrawAll, applyTimer, applyCinemaState, peerName, isPlaying]);

  // One place that turns a launch into activity state. Stable so the launch
  // effect below only depends on the request itself.
  const performLaunch = useCallback(
    (launch: ActivityLaunch) => {
      if (launch.type === 'timer') {
        startTimerWithSeconds((launch.durationMin ?? 45) * 60);
        setActiveModal('cafe');
      } else if (launch.type === 'cinema') {
        // Start Together on a shared watch: play from wherever the video is.
        const video = videoRef.current;
        const position = video ? video.currentTime : cinemaStateRef.current.position;
        sendCinemaAction(true, position, `${ownName} started the shared watch`);
        setActiveModal('cinema');
      } else if (launch.type === 'canvas') {
        setActiveModal('canvas');
      }
    },
    [startTimerWithSeconds, sendCinemaAction, ownName]
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

  const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const point = getCanvasPoint(e);
    if (!point) return;

    // Pointer capture keeps the stroke alive even when the pointer leaves the
    // canvas mid-drag; touch-action:none (on the style below) stops the page
    // from scrolling instead of drawing on phones.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Unsupported pointer id (or jsdom) — drawing still works while the
      // pointer stays on the canvas.
    }

    currentStrokeRef.current = { points: [point], color: myColor };
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.strokeStyle = myColor;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    setIsDrawing(true);
  };

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
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

  const stopDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    setIsDrawing(false);
    // The final pointer position (up/cancel) closes the stroke when present.
    if (e) {
      const point = getCanvasPoint(e);
      if (point && currentStrokeRef.current) currentStrokeRef.current.points.push(point);
    }
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    if (stroke && stroke.points.length > 0) {
      strokesRef.current = [...strokesRef.current, stroke];
      // Ship the completed stroke to the real peer over the active transport.
      connection.send('canvas-stroke', stroke);
    }

    // Simulated partner drawing is the offline fallback for local solo mode
    // only — a real peer draws back over the active transport. The heart is
    // drawn relative to the actual canvas size, never fixed coordinates.
    if (!hasPeer && connection.mode === 'local' && canvasLogs.length === 0) {
      setPartnerDrawing(true);
      setCanvasLogs(prev => [`${nameB || 'User B'} is drawing…`, ...prev]);

      partnerDrawTimerRef.current = window.setTimeout(() => {
        const canvas = canvasRef.current;
        const rect = canvas?.getBoundingClientRect();
        const cx = rect ? rect.width / 2 : 250;
        const cy = rect ? rect.height / 2 : 100;
        strokesRef.current = [...strokesRef.current, ...buildHeartStrokes(cx, cy)];
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

  // Modal lifecycle — Escape and the close button share one path. Closing the
  // cinema modal is local only: the shared watch keeps its state (the peer
  // keeps watching), and reopening resumes from the last shared position.
  const closeCinema = () => {
    if (cinemaTimerRef.current !== null) window.clearTimeout(cinemaTimerRef.current);
    setActiveModal(null);
  };
  const closeCanvas = () => {
    if (partnerDrawTimerRef.current !== null) window.clearTimeout(partnerDrawTimerRef.current);
    setActiveModal(null);
  };
  const closeCafe = () => setActiveModal(null);

  // Activity list — one quiet strip of verbs. The open activity (its modal)
  // carries the product names and the visual focus, not a card state.
  // One quiet strip of verbs. The full product names live on the open
  // activity's modal and in the aria-labels; the row itself stays calm.
  const activities: Activity[] = [
    {
      id: 'cinema',
      title: 'SynchroCinema',
      desc: 'Watch',
      icon: <Video size={16} color="var(--text-secondary)" />
    },
    {
      id: 'canvas',
      title: 'Galactic Canvas',
      desc: 'Draw',
      icon: <Paintbrush size={16} color="var(--text-secondary)" />
    },
    {
      id: 'cafe',
      title: 'Deep Space Coffee',
      desc: 'Focus',
      icon: <Coffee size={16} color="var(--text-secondary)" />
    },
    {
      id: 'chat',
      title: 'Conversation',
      desc: 'Talk',
      icon: <MessageCircle size={16} color="var(--text-secondary)" />
    }
  ];

  const openActivity = (id: string) => {
    if (id === 'chat') {
      document.getElementById('chat-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setActiveModal(id);
  };

  return (
    <div id="activity-center" className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div className="flex-between" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <h2 className="section-title">Shared Activities</h2>
        <span style={{ fontSize: 'var(--text-meta-size)', color: 'var(--text-muted)' }}>
          synced between you
        </span>
      </div>

      <div className="activity-strip" aria-label="Shared activities">
        {activities.map((act) => (
          <button
            key={act.id}
            onClick={() => openActivity(act.id)}
            className="activity-action"
            aria-label={`Open ${act.title}`}
            title={act.title}
            aria-pressed={activeModal === act.id}
          >
            {act.icon}
            <span>{act.desc}</span>
          </button>
        ))}
      </div>

      {/* ---------------------------------------------------- */}
      {/* SynchroCinema Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cinema' && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="SynchroCinema"
          onKeyDown={(e) => handleModalKeys(e, closeCinema)}
        >
          <div
            className="glass-panel modal-panel modal-panel--wide"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div className="flex-between">
              <h3 className="section-title" style={{ fontSize: 'var(--text-subheading-size)' }}>
                <Video size={16} color="var(--text-secondary)" />
                SynchroCinema
              </h3>
              <button onClick={closeCinema} className="modal-close" aria-label="Close SynchroCinema">
                <X size={18} />
              </button>
            </div>

            <div className="cinema-frame">
              <video
                ref={videoRef}
                src={CINEMA_VIDEO_SRC}
                loop
                playsInline
                muted={videoMuted}
                preload="auto"
                aria-label="Shared video"
                onLoadedMetadata={() => {
                  const video = videoRef.current;
                  if (!video) return;
                  if (Number.isFinite(video.duration) && video.duration > 0) {
                    setVideoDuration(video.duration);
                  }
                  // Resume from the last shared position, advanced by the
                  // wall-clock time elapsed since that state was true.
                  const { playing, position, at } = cinemaStateRef.current;
                  const elapsed = (Date.now() - at) / 1000;
                  try {
                    video.currentTime = Math.max(0, position + (playing ? elapsed : 0));
                  } catch {
                    // setting currentTime before metadata is inert — safe to skip
                  }
                }}
                onDurationChange={() => {
                  const video = videoRef.current;
                  if (video && Number.isFinite(video.duration) && video.duration > 0) {
                    setVideoDuration(video.duration);
                  }
                }}
                onTimeUpdate={() => {
                  const video = videoRef.current;
                  if (video) setVideoTime(video.currentTime);
                }}
              />
            </div>

            <div className="cinema-controls">
              <button
                onClick={handleCinemaToggle}
                className="btn btn-primary"
                aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
                style={{ padding: '9px 18px' }}
              >
                {isPlaying ? <Pause size={15} /> : <Play size={15} />}
                {isPlaying ? 'Pause' : 'Play'}
              </button>
              <input
                className="cinema-seek"
                type="range"
                aria-label="Seek video"
                min={0}
                // Generous ceiling until metadata loads; the real duration
                // replaces it on loadedmetadata (a 0 max would pin the thumb).
                max={videoDuration || 600}
                step={0.1}
                value={videoTime}
                onChange={(e) => handleCinemaSeek(Number(e.target.value))}
              />
              <span className="cinema-time">
                {formatTime(videoTime)} / {formatTime(videoDuration)}
              </span>
              <button
                onClick={() => setVideoMuted((muted) => !muted)}
                className="btn btn-outline"
                aria-label={videoMuted ? 'Unmute' : 'Mute'}
                aria-pressed={!videoMuted}
                style={{ padding: '9px 12px' }}
              >
                {videoMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
              </button>
            </div>

            <div className="flex-between">
              <span className={syncStatus === 'Synced' ? 'cinema-sync is-synced' : 'cinema-sync'}>
                <Users size={13} />
                {syncStatus}
              </span>
              <span className="meta">one playback point on both screens</span>
            </div>

            <div className="group activity-log">
              {cinemaLogs.map((log, idx) => (
                <div key={idx} className={idx === 0 ? 'log-line log-line--latest' : 'log-line'}>
                  {log}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- */}
      {/* Galactic Canvas Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'canvas' && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Galactic Canvas"
          onKeyDown={(e) => handleModalKeys(e, closeCanvas)}
        >
          <div
            className="glass-panel modal-panel"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div className="flex-between">
              <h3 className="section-title" style={{ fontSize: 'var(--text-subheading-size)' }}>
                <Paintbrush size={16} color="var(--text-secondary)" />
                Galactic Canvas
              </h3>
              <button onClick={closeCanvas} className="modal-close" aria-label="Close Galactic Canvas">
                <X size={18} />
              </button>
            </div>

            <div className="canvas-wrap">
              <canvas
                ref={canvasRef}
                onPointerDown={startDrawing}
                onPointerMove={draw}
                onPointerUp={stopDrawing}
                onPointerCancel={stopDrawing}
                aria-label="Shared drawing canvas"
                style={{ touchAction: 'none' }}
              />
              {partnerDrawing && (
                <span className="canvas-partner">{nameB || 'Partner'} is drawing…</span>
              )}
            </div>

            <div className="flex-between">
              <button onClick={clearCanvas} className="btn btn-outline" style={{ padding: '8px 14px' }}>
                <RotateCcw size={14} /> Clear
              </button>
              <span className="meta">strokes sync live</span>
            </div>

            <div className="group activity-log">
              {canvasLogs.length > 0 ? (
                canvasLogs.map((log, idx) => (
                  <div key={idx} className={idx === 0 ? 'log-line log-line--latest' : 'log-line'}>
                    {log}
                  </div>
                ))
              ) : (
                <div className="log-line log-line--empty">Awaiting the first stroke…</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- */}
      {/* Deep Space Coffee Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cafe' && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Deep Space Coffee"
          onKeyDown={(e) => handleModalKeys(e, closeCafe)}
        >
          <div
            className="glass-panel modal-panel"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div className="flex-between">
              <h3 className="section-title" style={{ fontSize: 'var(--text-subheading-size)' }}>
                <Coffee size={16} color="var(--text-secondary)" />
                Deep Space Coffee
              </h3>
              <button onClick={closeCafe} className="modal-close" aria-label="Close Deep Space Coffee">
                <X size={18} />
              </button>
            </div>

            <div className="timer-face">
              <div className="timer-count">{formatTime(secondsLeft)}</div>
              <span className="meta">a shared focus session</span>
            </div>

            {sessionLogs.length > 0 && (
              <div className="group activity-log">
                {sessionLogs.map((log, idx) => (
                  <div key={idx} className={idx === 0 ? 'log-line log-line--latest' : 'log-line'}>
                    {log}
                  </div>
                ))}
              </div>
            )}

            <div className="timer-controls">
              <button onClick={handleStartTimer} disabled={isRunning} className="btn btn-primary">
                <Play size={14} /> Start
              </button>
              <button onClick={handlePauseTimer} disabled={!isRunning} className="btn btn-outline">
                <Pause size={14} /> Pause
              </button>
              <button onClick={handleResetTimer} className="btn btn-outline">
                <RotateCcw size={14} /> Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
