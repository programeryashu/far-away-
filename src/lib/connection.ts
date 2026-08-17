import {
  CINEMA_EVENT,
  makeEnvelope,
  parseClientEnvelope,
  parseServerEnvelope,
  type BaseEnvelope,
  type ChatSendPayload,
  type CinemaPayload,
  type ClientEnvelope,
  type ClientEventName,
  type PingPayload,
  type ServerEnvelope,
  type StrokePayload,
  type TimerPayload,
} from '../../shared/protocol';
import { OrbitSync, type SyncMessage } from './broadcast';
import { RealtimeClient, type ConnectionStatus } from './realtime';
import type { ClientSession } from './session';

/** Payload type for a given client→server event, taken from the shared contract. */
export type ClientPayload<K extends ClientEventName> = Extract<
  ClientEnvelope,
  { event: K }
>['payload'];

/**
 * One transport-agnostic connection. Components talk to this and never care
 * whether the peer is another tab (BroadcastChannel) or a remote device
 * (WebSocket).
 */
export interface Connection {
  readonly mode: 'local' | 'remote';
  /**
   * Which person this connection represents: 'a' is the host tab / User A,
   * 'b' the second tab / User B. Local mode derives it from the tab side,
   * remote mode from the server-assigned role.
   */
  readonly role: 'a' | 'b';

  start(): void;
  stop(): void;

  send<K extends ClientEventName>(event: K, payload: ClientPayload<K>): void;

  onEvent(listener: (event: ServerEnvelope) => void): () => void;
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
  onPeerChange(listener: (hasPeer: boolean) => void): () => void;
  /**
   * Fires whenever the remote catch-up position (last applied event seq)
   * advances, so the app can persist it as session metadata. Local mode has no
   * server event stream and never fires.
   */
  onSeqChange(listener: (seq: number) => void): () => void;
}

/**
 * BroadcastChannel-backed connection wrapping OrbitSync. The peer is another
 * tab of this app on the same origin. The sync instance itself is owned by
 * App (app-lifetime); this adapter subscribes/unsubscribes and translates
 * between the local channel messages and the shared protocol envelopes.
 */
export class LocalConnection implements Connection {
  readonly mode = 'local' as const;

  private sync: OrbitSync;
  private listeners = new Set<(event: ServerEnvelope) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private peerListeners = new Set<(hasPeer: boolean) => void>();
  private status: ConnectionStatus = 'idle';
  private started = false;
  private unsubMessage: (() => void) | null = null;
  private unsubPeer: (() => void) | null = null;
  // The ping we sent and have not yet answered — the sender must not answer
  // its own echo on the channel.
  private ownPingTs: number | null = null;
  private simTimer: number | null = null;

  constructor(sync: OrbitSync) {
    this.sync = sync;
  }

  get role(): 'a' | 'b' {
    return this.sync.side === 'host' ? 'a' : 'b';
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Idempotent: the sync may already be running (App starts it too).
    this.sync.start();
    this.unsubMessage = this.sync.onMessage((msg) => this.handleMessage(msg));
    this.unsubPeer = this.sync.onPeersChange((hasPeer) => {
      this.peerListeners.forEach((listener) => listener(hasPeer));
    });
    this.setStatus('connected');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.simTimer !== null) {
      window.clearTimeout(this.simTimer);
      this.simTimer = null;
    }
    this.ownPingTs = null;
    this.unsubMessage?.();
    this.unsubMessage = null;
    this.unsubPeer?.();
    this.unsubPeer = null;
    this.setStatus('disconnected');
  }

  send<K extends ClientEventName>(event: K, payload: ClientPayload<K>): void {
    // Same outbound gate as the remote transport: an invalid frame never
    // leaves the client, on any transport.
    const frame = makeEnvelope({ event, payload });
    if (!parseClientEnvelope(frame)) {
      console.error(`[orbit] refusing to send invalid '${event}' frame on the local channel`);
      return;
    }
    switch (event) {
      case 'chat': {
        const p = payload as ChatSendPayload;
        this.sync.sendChat({
          id: p.id ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          sender: p.sender ?? '',
          text: p.text,
          timestamp:
            p.timestamp ??
            new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        break;
      }
      case 'ping': {
        const { ts } = payload as PingPayload;
        this.ownPingTs = ts;
        if (this.sync.hasPeer) {
          this.sync.sendPing(ts);
        } else {
          // Solo fallback: emulate the peer's pong (previously in PingMeter).
          this.simTimer = window.setTimeout(() => {
            this.simTimer = null;
            this.ownPingTs = null;
            this.emit(makeEnvelope({ event: 'pong', payload: { ts } }));
          }, 25 + Math.random() * 65);
        }
        break;
      }
      case 'cinema':
        this.sync.sendCinema((payload as CinemaPayload).playing, (payload as CinemaPayload).position);
        break;
      case 'timer':
        this.sync.sendTimer(payload as TimerPayload);
        break;
      case 'canvas-stroke':
        this.sync.sendStroke(payload as StrokePayload);
        break;
      case 'canvas-clear':
        this.sync.sendCanvasClear();
        break;
      case 'identity-update':
      case 'state-request':
      case 'hello':
        // No server in local mode: identity is shared via the connection
        // messages and there is no persisted state to request.
        break;
    }
  }

  onEvent(listener: (event: ServerEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onPeerChange(listener: (hasPeer: boolean) => void): () => void {
    this.peerListeners.add(listener);
    listener(this.sync.hasPeer);
    return () => this.peerListeners.delete(listener);
  }

  onSeqChange(): () => void {
    // No server event stream in local mode — nothing ever advances.
    return () => undefined;
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status));
  }

  private handleMessage(msg: SyncMessage) {
    switch (msg.type) {
      case 'chat':
        this.emit(
          makeEnvelope({
            event: 'chat',
            payload: {
              id: msg.payload.id,
              peerId: '',
              sender: msg.payload.sender,
              text: msg.payload.text,
              seq: 0,
              timestamp: Date.now(),
            },
          }),
        );
        break;
      case 'cinema':
        this.emit(
          makeEnvelope({
            event: CINEMA_EVENT,
            payload: { playing: msg.playing, position: msg.position },
          }),
        );
        break;
      case 'timer':
        this.emit(makeEnvelope({ event: 'timer', payload: msg.payload }));
        break;
      case 'canvas-stroke':
        this.emit(makeEnvelope({ event: 'canvas-stroke', payload: msg.payload }));
        break;
      case 'canvas-clear':
        this.emit(makeEnvelope({ event: 'canvas-clear', payload: {} }));
        break;
      case 'pong':
        if (msg.ts === this.ownPingTs) this.ownPingTs = null;
        this.emit(makeEnvelope({ event: 'pong', payload: { ts: msg.ts } }));
        break;
      case 'ping':
        // Answer the way the server would — except our own ping, whose pong
        // already comes back through the channel.
        if (msg.ts === this.ownPingTs) return;
        this.sync.sendPong(msg.ts);
        break;
      default:
        // presence/leave/names/connection/canvas-drawing are not activity
        // events; the adapter consumes them internally.
        break;
    }
  }

  /**
   * Every event delivered to components is a schema-valid server envelope —
   * the same invariant the remote transport enforces at the socket boundary.
   */
  private emit(env: BaseEnvelope) {
    const parsed = parseServerEnvelope(env);
    if (!parsed) {
      console.error(
        `[orbit] dropping locally-produced '${env.event}' frame that fails the server envelope schema`,
      );
      return;
    }
    this.listeners.forEach((listener) => listener(parsed));
  }
}

/**
 * WebSocket-backed connection wrapping RealtimeClient for one participant in
 * a server session. Presence is socket truth: derived from peer-joined /
 * peer-left envelopes, never from database membership.
 */
export class RemoteConnection implements Connection {
  readonly mode = 'remote' as const;
  readonly role: 'a' | 'b';
  readonly session: ClientSession;

  private client: RealtimeClient;
  private listeners = new Set<(event: ServerEnvelope) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private peerListeners = new Set<(hasPeer: boolean) => void>();
  private onlinePeers = new Set<string>();
  // Once the app leaves (or swaps away), this connection is permanently
  // silent: late close/status events — e.g. the server kicking the socket
  // during a leave — must never reach the UI after it has moved on.
  private stopped = false;

  constructor(session: ClientSession) {
    this.session = session;
    this.role = session.role;
    this.client = new RealtimeClient(
      session.sessionId,
      session.peerId,
      session.token ?? '',
      session.lastAppliedEventSeq ?? 0,
    );

    this.client.onEvent((env) => {
      if (env.event === 'peer-joined') {
        // Never count our own identity (a duplicate tab / overlapping reload)
        // as a remote peer, and never double-notify.
        if (env.payload.peerId !== session.peerId && !this.onlinePeers.has(env.payload.peerId)) {
          this.onlinePeers.add(env.payload.peerId);
          this.emitPeerChange();
        }
      } else if (env.event === 'peer-left') {
        if (this.onlinePeers.delete(env.payload.peerId)) {
          this.emitPeerChange();
        }
      }
      this.listeners.forEach((listener) => listener(env));
    });
    this.client.onStatusChange((status) => {
      if (this.stopped) return;
      this.statusListeners.forEach((listener) => listener(status));
    });
  }

  start(): void {
    // A re-started connection is live again. stop() silences it for the
    // leave/swap path; starting it again (e.g. React StrictMode's dev
    // mount → cleanup → mount) must not leave it permanently deaf.
    this.stopped = false;
    this.client.connect();
  }

  stop(): void {
    // Silence first, then tear down: the socket's close event may arrive
    // asynchronously (or the server may have already kicked it), and nothing
    // a dying connection says afterwards may reach the UI.
    this.stopped = true;
    this.client.disconnect();
  }

  send<K extends ClientEventName>(event: K, payload: ClientPayload<K>): void {
    this.client.send(event, payload);
  }

  onEvent(listener: (event: ServerEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.client.getStatus());
    return () => this.statusListeners.delete(listener);
  }

  onPeerChange(listener: (hasPeer: boolean) => void): () => void {
    this.peerListeners.add(listener);
    listener(this.onlinePeers.size > 0);
    return () => this.peerListeners.delete(listener);
  }

  onSeqChange(listener: (seq: number) => void): () => void {
    return this.client.onSeqChange(listener);
  }

  private emitPeerChange() {
    const hasPeer = this.onlinePeers.size > 0;
    this.peerListeners.forEach((listener) => listener(hasPeer));
  }
}

/**
 * Transport selection lives here, in one place: a server session means a
 * WebSocket connection, otherwise the local BroadcastChannel connection.
 */
export function createConnection(
  sync: OrbitSync,
  session: ClientSession | null,
): Connection {
  return session ? new RemoteConnection(session) : new LocalConnection(sync);
}
