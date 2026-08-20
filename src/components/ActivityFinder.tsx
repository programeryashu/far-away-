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
  MessageCircle,
  Search,
  ArrowLeft,
  Sparkles
} from 'lucide-react';
import type { TimerPayload } from '../lib/broadcast';
import type { Connection } from '../lib/connection';
import { parseCanvasStrokes, parseCinemaState, parseTimerState } from '../lib/reconcile';
import { CINEMA_EVENT, type CinemaPayload, type SelectedMovie } from '../../shared/protocol';
import {
  searchWatch,
  fetchWatchMovie,
  fetchWatchAvailability,
  pickWatchMovie,
  type WatchMovie,
  type RegionAvailability,
  type WatchPickResult
} from '../lib/watch';

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
  /**
   * Fired once when the user starts an activity here (timer, cinema play,
   * first canvas stroke). The parent decides what that means for presence
   * (e.g. surfacing the join-code invitation when the peer is away).
   */
  onActivityStarted?: (activity: string) => void;
  /** Home country of each person — used for watch availability lookups. */
  countryA: string;
  countryB: string;
  /** Shared-time window in minutes (the pick-for-us runtime ceiling). */
  windowMinutes: number;
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

/** Compact poster-or-placeholder art for a movie row. */
const WatchRowArt: React.FC<{ movie: WatchMovie }> = ({ movie }) => {
  if (movie.poster) {
    return <img src={movie.poster} alt="" className="watch-row-art" loading="lazy" />;
  }
  return (
    <div className="watch-row-art watch-row-art--placeholder" aria-hidden="true">
      <Video size={14} />
    </div>
  );
};

export const ActivityFinder: React.FC<ActivityFinderProps> = ({
  nameA,
  nameB,
  connection,
  hasPeer,
  launchRequest = null,
  onActivityStarted,
  countryA,
  countryB,
  windowMinutes
}) => {
  const [activeModal, setActiveModal] = useState<string | null>(null);

  // ----------------------------------------------------
  // Watch 2.0 — discovery first, then a chosen movie
  // ----------------------------------------------------
  // The cinema modal has three screens: discover (search / pick-for-us),
  // detail (one movie + availability), and the live player. A movie chosen
  // in the session rides the cinema state, so a fresh joiner or reconnect
  // inherits it — the player screen is derived from `selectedMovie`.
  const [watchScreen, setWatchScreen] = useState<'discover' | 'detail' | 'player'>('discover');
  const [selectedMovie, setSelectedMovie] = useState<SelectedMovie | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'done' | 'error' | 'unconfigured'>('idle');
  const [searchResults, setSearchResults] = useState<WatchMovie[]>([]);
  const [detailMovie, setDetailMovie] = useState<WatchMovie | null>(null);
  const [detailAvailability, setDetailAvailability] = useState<RegionAvailability[] | null>(null);
  const [detailStatus, setDetailStatus] = useState<'idle' | 'loading' | 'done' | 'error' | 'unconfigured'>('idle');
  const [pickStatus, setPickStatus] = useState<'idle' | 'loading' | 'done' | 'error' | 'unconfigured'>('idle');
  const [pickResult, setPickResult] = useState<WatchPickResult | null>(null);

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
  const [cinemaLogs, setCinemaLogs] = useState<string[]>(['Ready']);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const cinemaTimerRef = useRef<number | null>(null);

  // Focus Timer State
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
    onActivityStarted?.('a shared timer');
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
  // re-anchors to the exact playback point. The chosen movie rides the
  // selection/start event only — later play/pause/seek events omit it and the
  // server keeps the stored movie.
  const sendCinemaAction = useCallback(
    (playing: boolean, position: number, log: string, movie?: SelectedMovie) => {
      applyCinemaState(playing, position);
      if (movie) setSelectedMovie(movie);
      setSyncStatus('Syncing…');
      setCinemaLogs(prev => [log, ...prev]);
      connection.send(
        CINEMA_EVENT,
        (movie
          ? { playing, position, movie }
          : { playing, position }) satisfies CinemaPayload,
      );
      if (cinemaTimerRef.current !== null) window.clearTimeout(cinemaTimerRef.current);
      cinemaTimerRef.current = window.setTimeout(() => setSyncStatus('Synced'), 1000);
    },
    [applyCinemaState, connection],
  );

  const handleCinemaToggle = () => {
    const video = videoRef.current;
    const position = video ? video.currentTime : cinemaStateRef.current.position;
    // Starting a watch is the canonical activity-start (reported on Watch
    // together); resuming/pausing playback in the player is continuation, not
    // a new activity start.
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

  // ----------------------------------------------------
  // Watch discovery — search / detail / pick-for-us
  // ----------------------------------------------------
  // Every request is honest about its outcome: a failure shows "Search
  // unavailable" (or "Watch unavailable" when the server has no key), never
  // a fabricated result or a bare "AI failed".
  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) return;
    setSearchStatus('loading');
    setPickStatus('idle');
    const result = await searchWatch(q);
    if (result.ok) {
      setSearchResults(result.data.movies);
      setSearchStatus('done');
    } else {
      setSearchStatus(result.reason === 'unconfigured' ? 'unconfigured' : 'error');
    }
  }, []);

  const openDetail = useCallback(async (movie: WatchMovie) => {
    setDetailMovie(movie);
    setDetailAvailability(null);
    setDetailStatus('loading');
    setWatchScreen('detail');
    // Search and popular rows lack the runtime; the detail call fills it in
    // (and refreshes overview/backdrop). On failure the row's own data still
    // stands — the screen never fabricates a runtime.
    const [detail, availability] = await Promise.all([
      fetchWatchMovie(movie.id),
      fetchWatchAvailability(movie.id, [countryA, countryB]),
    ]);
    if (detail.ok) setDetailMovie(detail.data.movie);
    if (availability.ok) {
      setDetailAvailability(availability.data.regions);
      setDetailStatus('done');
    } else {
      setDetailStatus(availability.reason === 'unconfigured' ? 'unconfigured' : 'error');
    }
  }, [countryA, countryB]);

  // Deterministic filtering happens server-side (runtime <= shared window,
  // availability when known); the AI may only rank among the validated
  // candidates, and any AI failure falls back to the deterministic pick.
  const runPick = useCallback(async () => {
    setPickStatus('loading');
    setSearchStatus('idle');
    const result = await pickWatchMovie(windowMinutes, [countryA, countryB]);
    if (result.ok) {
      setPickResult(result.data);
      setPickStatus('done');
    } else {
      setPickStatus(result.reason === 'unconfigured' ? 'unconfigured' : 'error');
    }
  }, [windowMinutes, countryA, countryB]);

  // "Watch together": persist the chosen movie with the play action — one
  // send, same persistence/replay path as every other cinema action. The
  // movie rides this event only; the server keeps it for later actions.
  const startWatch = useCallback(async (movie: WatchMovie) => {
    onActivityStarted?.('a shared watch');
    const selected: SelectedMovie = {
      id: movie.id,
      title: movie.title,
      year: movie.year ?? undefined,
      runtime: movie.runtime ?? undefined,
      overview: movie.overview ?? undefined,
      poster: movie.poster ?? undefined,
      backdrop: movie.backdrop ?? undefined,
    };
    sendCinemaAction(true, 0, `${ownName} started the shared watch — ${movie.title}`, selected);
    setWatchScreen('player');
  }, [onActivityStarted, sendCinemaAction, ownName]);

  // Opening the modal always lands on discovery — never straight into
  // playback. If a movie is already chosen in the session (fresh joiner),
  // discovery still shows it first with a resume affordance.
  const openCinema = useCallback(() => {
    setWatchScreen('discover');
    setActiveModal('cinema');
  }, []);

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
        const { playing, position, movie } = env.payload;
        // A watch selection rides the start event — adopt the chosen movie so
        // both screens show it (fresh joiner included).
        if (movie) setSelectedMovie(movie);
        // The server echoes cinema events to the sender too (so the sender's
        // event-seq floor advances). Our own echo — or any action that would
        // not change the current state — is a no-op, never a re-anchor or a
        // log line; a real peer action differs in play state or position.
        const currentPos = videoRef.current
          ? videoRef.current.currentTime
          : cinemaStateRef.current.position;
        // Compare against the last APPLIED shared state, not the rendered
        // `isPlaying`: the echo of our own action is processed over the
        // socket, and the render that commits our new play state can arrive
        // after it. Comparing with the closure value would then misread the
        // echo as a peer action and log a phantom "peer paused/played".
        // cinemaStateRef is updated synchronously before the send, so it is
        // always the current truth when the echo arrives.
        //
        // Positions are also normalized into the clip's loop before comparing:
        // the shared position is absolute (e.g. 33.2) while the video's
        // currentTime wraps at the duration (0.2), so a raw difference would
        // misread our own echo near the loop boundary as a peer action.
        const loop = (v: number) =>
          videoDuration > 0 ? ((v % videoDuration) + videoDuration) % videoDuration : v;
        if (
          playing === cinemaStateRef.current.playing &&
          Math.abs(loop(position) - loop(currentPos)) < 2
        ) {
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
          // A fresh joiner inherits the chosen movie from the snapshot.
          if (cinema.movie) setSelectedMovie(cinema.movie);
          setSyncStatus('Synced');
        }
      }
    });
  }, [connection, redrawAll, applyTimer, applyCinemaState, peerName, videoDuration]);

  // One place that turns a launch into activity state. Stable so the launch
  // effect below only depends on the request itself.
  const performLaunch = useCallback(
    (launch: ActivityLaunch) => {
      if (launch.type === 'timer') {
        startTimerWithSeconds((launch.durationMin ?? 45) * 60);
        setActiveModal('cafe');
      } else if (launch.type === 'cinema') {
        // Start Together on a shared watch: land on discovery — the movie
        // choice is the watch decision, playback follows it.
        setWatchScreen('discover');
        setActiveModal('cinema');
      } else if (launch.type === 'canvas') {
        setActiveModal('canvas');
      }
    },
    [startTimerWithSeconds]
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
    if (strokesRef.current.length === 0) onActivityStarted?.('Canvas');
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
      title: 'Watch',
      desc: 'Watch',
      icon: <Video size={16} color="var(--text-secondary)" />
    },
    {
      id: 'canvas',
      title: 'Canvas',
      desc: 'Draw',
      icon: <Paintbrush size={16} color="var(--text-secondary)" />
    },
    {
      id: 'cafe',
      title: 'Focus',
      desc: 'Focus',
      icon: <Coffee size={16} color="var(--text-secondary)" />
    },
    {
      id: 'chat',
      title: 'Talk',
      desc: 'Talk',
      icon: <MessageCircle size={16} color="var(--text-secondary)" />
    }
  ];

  const openActivity = (id: string) => {
    if (id === 'chat') {
      document.getElementById('chat-box')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (id === 'cinema') {
      openCinema();
      return;
    }
    setActiveModal(id);
  };

  return (
    <div id="activity-center" className="open-section" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>        <div style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <h2 className="open-section-title">Do something together</h2>
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
      {/* Watch Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cinema' && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Watch"
          onKeyDown={(e) => handleModalKeys(e, closeCinema)}
        >
          <div
            className="glass-panel modal-panel modal-panel--wide"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div className="flex-between">
              <h3 className="section-title" style={{ fontSize: 'var(--text-subheading-size)' }}>
                <Video size={16} color="var(--text-secondary)" />
                Watch
              </h3>
              <button
                onClick={closeCinema}
                className="modal-close"
                aria-label="Close Watch"
              >
                <X size={18} />
              </button>
            </div>

            {watchScreen === 'discover' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                <div>
                  <span className="eyebrow">Watch</span>
                  <h4 className="section-title" style={{ fontSize: 'var(--text-subheading-size)', marginTop: '2px' }}>
                    What do we want to watch?
                  </h4>
                  <p className="meta" style={{ marginTop: '4px' }}>
                    Find something you both can watch — availability is checked for both of you.
                  </p>
                </div>

                {/* Resume the session's watch, when one is chosen or already
                    playing (a fresh joiner inherits playback). */}
                {(selectedMovie || isPlaying) && (
                  <div className="watch-resume">
                    {selectedMovie?.poster ? (
                      <img src={selectedMovie.poster} alt="" className="watch-resume-poster" loading="lazy" />
                    ) : (
                      <div className="watch-resume-poster watch-resume-poster--placeholder" aria-hidden="true">
                        <Video size={18} />
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 }}>
                      <span className="meta">Now watching</span>
                      <strong style={{ fontSize: 'var(--text-label-size)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {selectedMovie ? selectedMovie.title : 'The shared watch'}
                        {selectedMovie?.year ? ` (${selectedMovie.year})` : ''}
                      </strong>
                      <span className="meta">Demo playback · synchronized</span>
                    </div>
                    <button
                      onClick={() => setWatchScreen('player')}
                      className="btn btn-primary"
                      style={{ gap: '6px', padding: '8px 14px', whiteSpace: 'nowrap' }}
                    >
                      <Play size={14} />
                      Resume
                    </button>
                  </div>
                )}

                <form
                  className="watch-search"
                  role="search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void runSearch(searchQuery);
                  }}
                >
                  <Search size={15} color="var(--text-secondary)" aria-hidden="true" />
                  <input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search movies…"
                    aria-label="Search movies"
                  />
                  <button type="submit" className="btn btn-primary" style={{ padding: '7px 14px' }} disabled={searchStatus === 'loading'}>
                    Search
                  </button>
                </form>

                <button
                  onClick={() => void runPick()}
                  className="btn btn-outline"
                  style={{ gap: '6px', padding: '8px 14px', alignSelf: 'flex-start' }}
                  disabled={pickStatus === 'loading'}
                >
                  <Sparkles size={14} />
                  Pick something for us
                </button>

                {pickStatus === 'loading' && (
                  <div className="meta">Looking for something that fits your {windowMinutes}-minute window…</div>
                )}
                {pickStatus === 'done' && pickResult && (
                  <div className="watch-list" role="list" aria-label="Suggested movies">
                    <div className="meta" style={{ marginBottom: '4px' }}>
                      {pickResult.pick
                        ? `We found ${pickResult.movies.length} short option${pickResult.movies.length === 1 ? '' : 's'} for your ${windowMinutes}-minute window.`
                        : `Nothing in the popular list fits your ${windowMinutes}-minute window. Try a search.`}
                    </div>
                    {pickResult.pick && (
                      <button
                        className="watch-row watch-row--pick"
                        style={{ '--stagger-index': 0 } as React.CSSProperties}
                        onClick={() => void openDetail(pickResult.pick!)}
                        aria-label={`Open ${pickResult.pick.title}`}
                      >
                        <WatchRowArt movie={pickResult.pick} />
                        <span className="watch-row-title">{pickResult.pick.title}</span>
                        <span className="watch-row-pick">our pick</span>
                      </button>
                    )}
                    {pickResult.movies
                      .filter((m) => !pickResult.pick || m.id !== pickResult.pick.id)
                      .map((m, i) => (
                        <button
                          key={m.id}
                          className="watch-row"
                          style={{ '--stagger-index': i + 1 } as React.CSSProperties}
                          onClick={() => void openDetail(m)}
                          aria-label={`Open ${m.title}`}
                        >
                          <WatchRowArt movie={m} />
                          <span className="watch-row-title">{m.title}</span>
                          <span className="watch-row-meta">
                            {m.year ?? ''}{m.runtime ? ` · ${m.runtime}m` : ''}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
                {pickStatus === 'error' && (
                  <div className="meta">Pick unavailable right now — try again in a moment.</div>
                )}
                {pickStatus === 'unconfigured' && (
                  <div className="meta">Watch search isn't configured on this server.</div>
                )}

                {searchStatus === 'loading' && <div className="meta">Searching…</div>}
                {searchStatus === 'done' && searchResults.length === 0 && (
                  <div className="meta">No movies found for “{searchQuery}”.</div>
                )}
                {searchStatus === 'done' && searchResults.length > 0 && (
                  <div className="watch-list" role="list" aria-label="Search results">
                    {searchResults.map((m, i) => (
                      <button
                        key={m.id}
                        className="watch-row"
                        style={{ '--stagger-index': i } as React.CSSProperties}
                        onClick={() => void openDetail(m)}
                        aria-label={`Open ${m.title}`}
                      >
                        <WatchRowArt movie={m} />
                        <span className="watch-row-title">{m.title}</span>
                        <span className="watch-row-meta">
                          {m.year ?? ''}{m.runtime ? ` · ${m.runtime}m` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {searchStatus === 'error' && (
                  <div className="meta">Search unavailable — try again in a moment.</div>
                )}
                {searchStatus === 'unconfigured' && (
                  <div className="meta">Watch search isn't configured on this server.</div>
                )}
              </div>
            )}

            {watchScreen === 'detail' && detailMovie && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                <button
                  onClick={() => setWatchScreen('discover')}
                  className="btn btn-outline"
                  style={{ gap: '6px', padding: '7px 12px', alignSelf: 'flex-start' }}
                >
                  <ArrowLeft size={14} />
                  Back
                </button>

                <div className="watch-detail">
                  {detailMovie.backdrop ? (
                    <img src={detailMovie.backdrop} alt="" className="watch-detail-backdrop" loading="lazy" />
                  ) : null}
                  <div className="watch-detail-main">
                    <h4 className="watch-detail-title">{detailMovie.title}</h4>
                    <div className="meta" style={{ marginTop: '2px' }}>
                      {[detailMovie.year, detailMovie.runtime ? `${detailMovie.runtime} min` : null]
                        .filter(Boolean)
                        .join(' · ') || 'Year unknown'}
                    </div>
                    {detailMovie.overview && (
                      <p className="watch-detail-overview">{detailMovie.overview}</p>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <span className="eyebrow">Availability</span>
                      {detailStatus === 'loading' && <span className="meta">Checking where it's watchable…</span>}
                      {detailStatus === 'done' &&
                        detailAvailability &&
                        // One row per person's country — the two-region answer.
                        // A country the provider has no data for reads
                        // "Availability unavailable", never a fabricated check.
                        [...new Set([countryA, countryB])].map((country) => {
                          const region = detailAvailability.find((r) => r.country === country);
                          return (
                            <div key={country} className="watch-avail">
                              <span className="watch-avail-country">{country}</span>
                              <span
                                className={
                                  region && region.providers.length > 0 ? 'watch-avail-yes' : 'watch-avail-no'
                                }
                              >
                                {region && region.providers.length > 0
                                  ? region.providers.join(' · ')
                                  : region
                                    ? 'Not available'
                                    : 'Availability unavailable'}
                              </span>
                            </div>
                          );
                        })}
                      {(detailStatus === 'error' || detailStatus === 'unconfigured') && (
                        <span className="meta">Availability unavailable</span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                  <button
                    onClick={() => void startWatch(detailMovie)}
                    className="btn btn-primary cta-attention"
                    style={{ gap: '6px', padding: '9px 16px' }}
                  >
                    <Play size={14} />
                    Watch together
                  </button>
                  <span className="meta" style={{ alignSelf: 'center' }}>
                    playback is a safe demo clip
                  </span>
                </div>
              </div>
            )}

            {watchScreen === 'player' && (
              <>
                {selectedMovie && (
                  <div className="flex-between" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <span className="eyebrow">Now watching</span>
                      <strong style={{ fontSize: 'var(--text-label-size)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {selectedMovie.title}
                        {selectedMovie.year ? ` (${selectedMovie.year})` : ''}
                      </strong>
                      <span className="meta">Demo playback</span>
                    </div>
                    <button
                      onClick={() => setWatchScreen('discover')}
                      className="btn btn-outline"
                      style={{ gap: '6px', padding: '7px 12px' }}
                    >
                      <Search size={14} />
                      Pick another
                    </button>
                  </div>
                )}

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
                  <span className="meta">synchronized</span>
                </div>

                <div className="group activity-log">
                  {cinemaLogs.map((log, idx) => (
                    <div key={idx} className={idx === 0 ? 'log-line log-line--latest' : 'log-line'}>
                      {log}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- */}
      {/* Canvas Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'canvas' && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Canvas"
          onKeyDown={(e) => handleModalKeys(e, closeCanvas)}
        >
          <div
            className="glass-panel modal-panel"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div className="flex-between">
              <h3 className="section-title" style={{ fontSize: 'var(--text-subheading-size)' }}>
                <Paintbrush size={16} color="var(--text-secondary)" />
                Canvas
              </h3>
              <button onClick={closeCanvas} className="modal-close" aria-label="Close Canvas">
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
      {/* Focus Modal */}
      {/* ---------------------------------------------------- */}
      {activeModal === 'cafe' && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Focus"
          onKeyDown={(e) => handleModalKeys(e, closeCafe)}
        >
          <div
            className="glass-panel modal-panel"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
          >
            <div className="flex-between">
              <h3 className="section-title" style={{ fontSize: 'var(--text-subheading-size)' }}>
                <Coffee size={16} color="var(--text-secondary)" />
                Focus
              </h3>
              <button onClick={closeCafe} className="modal-close" aria-label="Close Focus">
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
