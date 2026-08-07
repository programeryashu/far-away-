// Orbit live-tab sync.
//
// Two tabs on the same origin talk over a BroadcastChannel: the first tab to
// load claims the "host" role (User A) and the second becomes "remote"
// (User B). Real chat, canvas strokes, cinema state, the focus timer, names
// and the connection (cities) travel across the channel. When no peer tab is
// present the UI keeps its built-in simulation as an offline fallback.

export type Side = 'host' | 'remote';

export interface CitySnapshot {
  name: string;
  country: string;
  lat: number;
  lng: number;
  timezone: string;
}

export interface ConnectionPayload {
  a: { name: string; city: CitySnapshot };
  b: { name: string; city: CitySnapshot };
}

export interface ChatPayload {
  id: string;
  sender: string;
  text: string;
  timestamp: string;
}

export interface StrokePayload {
  points: { x: number; y: number }[];
  color: string;
}

export interface TimerPayload {
  action: 'start' | 'pause' | 'reset';
  /** Wall-clock ms the shared timer should reach zero (start only). */
  endAt: number;
  /** Seconds left at broadcast time (pause / reset). */
  remaining: number;
}

export type SyncMessage =
  | { type: 'presence'; tabId: string; side: Side; ts: number }
  | { type: 'leave'; tabId: string }
  | { type: 'names-request' }
  | { type: 'names'; nameA: string; nameB: string }
  | { type: 'connection'; payload: ConnectionPayload }
  | { type: 'chat'; payload: ChatPayload }
  | { type: 'canvas-stroke'; payload: StrokePayload }
  | { type: 'canvas-clear' }
  | { type: 'canvas-drawing'; active: boolean }
  | { type: 'cinema'; playing: boolean }
  | { type: 'timer'; payload: TimerPayload }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number };

const CHANNEL_NAME = 'orbit-live-v1';
const ROLE_KEY = 'orbit.tab-role';
const HEARTBEAT_MS = 3000;
const PEER_STALE_MS = 9000;

const randomTabId = () =>
  Math.random().toString(36).slice(2, 10) + new Date().getTime().toString(36);

export class OrbitSync {
  readonly tabId: string = randomTabId();
  /** Which person this tab is. Assigned on start(), not construction. */
  side: Side = 'host';

  private channel: BroadcastChannel | null = null;
  private listeners = new Set<(msg: SyncMessage) => void>();
  private peerWatchers = new Set<(hasPeer: boolean) => void>();
  private lastSeen = new Map<string, number>();
  private heartbeatId: number | null = null;
  hasPeer = false;

  private handleMessage = (event: MessageEvent) => {
    const msg = event.data as SyncMessage;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.type === 'presence') {
      if (msg.tabId !== this.tabId) {
        this.lastSeen.set(msg.tabId, msg.ts);
        this.updatePeerState();
      }
      return;
    }
    if (msg.type === 'leave') {
      this.lastSeen.delete(msg.tabId);
      this.updatePeerState();
      return;
    }
    for (const fn of this.listeners) fn(msg);
  };

  private updatePeerState = () => {
    const now = new Date().getTime();
    for (const [tabId, ts] of this.lastSeen) {
      if (now - ts > PEER_STALE_MS) this.lastSeen.delete(tabId);
    }
    const next = this.lastSeen.size > 0;
    if (next !== this.hasPeer) {
      this.hasPeer = next;
      for (const fn of this.peerWatchers) fn(next);
    }
  };

  start(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') return;
    // Claim the host role now, while the other tab has not yet started.
    try {
      if (localStorage.getItem(ROLE_KEY) !== 'host') {
        localStorage.setItem(ROLE_KEY, 'host');
        this.side = 'host';
      } else {
        this.side = 'remote';
      }
    } catch {
      this.side = 'host';
    }
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.addEventListener('message', this.handleMessage);
    this.announce();
    this.heartbeatId = window.setInterval(() => {
      this.announce();
      this.updatePeerState();
    }, HEARTBEAT_MS);
  }

  private announce(): void {
    this.channel?.postMessage({
      type: 'presence',
      tabId: this.tabId,
      side: this.side,
      ts: new Date().getTime()
    });
  }

  private send(msg: SyncMessage): void {
    if (!this.channel) return;
    try {
      this.channel.postMessage(msg);
    } catch {
      // Channel closed mid-broadcast — drop the message.
    }
  }

  onMessage(fn: (msg: SyncMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onPeersChange(fn: (hasPeer: boolean) => void): () => void {
    this.peerWatchers.add(fn);
    return () => this.peerWatchers.delete(fn);
  }

  requestNames(): void {
    this.send({ type: 'names-request' });
  }
  sendNames(nameA: string, nameB: string): void {
    this.send({ type: 'names', nameA, nameB });
  }
  sendConnection(payload: ConnectionPayload): void {
    this.send({ type: 'connection', payload });
  }
  sendChat(payload: ChatPayload): void {
    this.send({ type: 'chat', payload });
  }
  sendStroke(payload: StrokePayload): void {
    this.send({ type: 'canvas-stroke', payload });
  }
  sendCanvasClear(): void {
    this.send({ type: 'canvas-clear' });
  }
  sendCanvasDrawing(active: boolean): void {
    this.send({ type: 'canvas-drawing', active });
  }
  sendCinema(playing: boolean): void {
    this.send({ type: 'cinema', playing });
  }
  sendTimer(payload: TimerPayload): void {
    this.send({ type: 'timer', payload });
  }
  sendPing(ts: number): void {
    this.send({ type: 'ping', ts });
  }
  sendPong(ts: number): void {
    this.send({ type: 'pong', ts });
  }

  dispose(): void {
    if (this.heartbeatId !== null) window.clearInterval(this.heartbeatId);
    this.heartbeatId = null;
    if (this.channel) {
      try {
        this.channel.postMessage({ type: 'leave', tabId: this.tabId });
      } catch {
        // Channel already closed.
      }
      this.channel.close();
      this.channel = null;
    }
    try {
      if (this.side === 'host') localStorage.removeItem(ROLE_KEY);
    } catch {
      // Storage unavailable — nothing to release.
    }
    this.listeners.clear();
    this.peerWatchers.clear();
    this.lastSeen.clear();
    this.hasPeer = false;
  }
}
