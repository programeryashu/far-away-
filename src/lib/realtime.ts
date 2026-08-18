import { parseClientEnvelope, parseServerEnvelope, PROTOCOL_VERSION, SEQUENCED_SERVER_EVENTS, type ServerEnvelope } from '../../shared/protocol';

export type RealtimeEvent = ServerEnvelope;
export type EventCallback = (envelope: RealtimeEvent) => void;
export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/**
 * Close codes 4000-4999 are application-defined rejections (invalid or expired
 * session/peer). Retrying them is pointless, so they are terminal.
 */
export function isTerminalCloseCode(code: number): boolean {
  return code >= 4000 && code <= 4999;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners: Set<EventCallback> = new Set();
  private sessionId: string;
  private peerId: string;
  /** Session-scoped peer secret from the join response (server verifies it on upgrade). */
  private token: string;
  private status: ConnectionStatus = 'idle';
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: number | null = null;
  // Outbound frames sent while the socket is (re)connecting. They are flushed
  // exactly once when the socket opens so a timer/chat/activity pressed right
  // around connection establishment is never silently dropped.
  private pending: { event: string; payload: unknown; seq: number }[] = [];
  // Durable per-session event stream tracking (server seqs are authoritative).
  private lastAppliedEventSeq: number;
  // A full state snapshot has been applied to this instance. Until then the
  // client has no base state (fresh page / fresh join), so catch-up requests
  // must ask for the snapshot, not a replay.
  private hasBase = false;
  // Sequenced events that arrived out of order (a gap) are held here until a
  // catch-up replay/snapshot fills the hole — never applied out of order.
  private pendingEvents = new Map<number, ServerEnvelope>();
  private seqListeners: Set<(seq: number) => void> = new Set();

  constructor(sessionId: string, peerId: string, token = '', initialSeq = 0) {
    this.sessionId = sessionId;
    this.peerId = peerId;
    this.token = token;
    // The persisted seq is used as the dedup floor for events that arrive in
    // the window before the first snapshot; the snapshot itself is
    // authoritative and can only move this forward.
    this.lastAppliedEventSeq = initialSeq;
  }

  get isConnected() {
    return this.status === 'connected';
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  onStatusChange(callback: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(callback);
    callback(this.status); // Initial status
    return () => this.statusListeners.delete(callback);
  }

  private setStatus(newStatus: ConnectionStatus) {
    if (this.status === newStatus) return;
    this.status = newStatus;
    this.statusListeners.forEach(listener => listener(newStatus));
  }

  connect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // A socket that is already open or connecting must not be replaced.
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url =
      `${protocol}//${window.location.host}/ws?sessionId=${this.sessionId}` +
      `&peerId=${this.peerId}&token=${encodeURIComponent(this.token)}`;
    // Every handler checks that its socket is still the live one: a stale
    // socket (e.g. one closed while still CONNECTING by an intentional
    // disconnect) must never clobber the current socket's reference, deliver
    // its messages, or schedule a reconnect. Without this guard, that late
    // close event (which browsers report as code 1006) would null the newer
    // socket and open a duplicate connection after the reconnect backoff.
    const socket = new WebSocket(url);
    this.ws = socket;

    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.setStatus('connected');
      this.reconnectAttempts = 0;
      // Catch-up first, then queued user actions: the server processes the
      // state-request before the user events, so the replayed range arrives
      // before the freshly-logged user event — no artificial gap.
      this.requestCatchUp();
      this.flushPending();
    };

    socket.onmessage = (event) => {
      if (this.ws !== socket) return;
      let data: unknown;
      try {
        data = JSON.parse(event.data);
      } catch {
        // Not a JSON frame — ignore. Malformed frames never crash the client.
        return;
      }
      // Only fully schema-valid server envelopes are delivered to listeners;
      // unknown future events and malformed payloads are dropped safely.
      const envelope = parseServerEnvelope(data);
      if (!envelope) return;

      if (envelope.event === 'state') {
        // The snapshot itself establishes base state. It is authoritative for
        // everything up to snapshotSeq — advance (never regress) and let the
        // listener reconcile the payload.
        this.hasBase = true;
        if (envelope.payload.snapshotSeq > this.lastAppliedEventSeq) {
          this.lastAppliedEventSeq = envelope.payload.snapshotSeq;
          this.notifySeq();
        }
        this.deliver(envelope);
        this.drainPending();
        return;
      }

      // Control frames (connected, peer-joined/left, ack, pong, error) are
      // not part of the durable event stream — pass them through as-is.
      if (!SEQUENCED_SERVER_EVENTS.has(envelope.event)) {
        this.deliver(envelope);
        return;
      }

      const seq = envelope.seq;
      if (seq <= this.lastAppliedEventSeq) return; // duplicate
      if (seq === this.lastAppliedEventSeq + 1) {
        this.applySequenced(envelope);
        this.drainPending();
        return;
      }
      // Gap: never apply out of order. Hold the frame and ask the server for
      // the missing range; replay (or a snapshot) fills the hole and the
      // drain above applies it.
      this.pendingEvents.set(seq, envelope);
      this.trimPending();
      this.requestCatchUp();
    };

    socket.onclose = (event) => {
      // A late close from a superseded socket (closed while CONNECTING by an
      // intentional disconnect) must not touch the live socket or reconnect.
      if (this.ws !== socket) return;
      this.ws = null;
      // Anything buffered while the socket was up will be re-requested via
      // the last applied seq on the next connection.
      this.pendingEvents.clear();
      if (isTerminalCloseCode(event.code)) {
        // Server rejected the session/peer — do not retry forever.
        this.pending = [];
        this.reconnectAttempts = 0;
        this.setStatus('error');
      } else if (event.code === 1000 || event.code === 1001) {
        this.pending = [];
        this.setStatus('disconnected');
      } else {
        this.handleReconnect();
      }
    };

    // Every error is followed by a close event; letting onclose drive
    // reconnection avoids scheduling duplicate reconnect timers.
    socket.onerror = () => {
      /* handled by onclose */
    };
  }

  private handleReconnect() {
    if (this.reconnectTimer !== null) return; // reconnect already scheduled
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.pending = [];
      this.setStatus('disconnected');
      return;
    }
    this.setStatus('reconnecting');
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(event: string, payload: unknown, seq = 0) {
    // Validate at the outbound boundary: malformed payloads must never leave
    // the client. Throwing makes a contract violation loud instead of letting
    // a bad frame be silently queued or sent.
    if (
      !parseClientEnvelope({
        version: PROTOCOL_VERSION,
        sessionId: this.sessionId,
        peerId: this.peerId,
        seq,
        timestamp: Date.now(),
        event,
        payload,
      })
    ) {
      throw new Error(`refusing to send invalid '${event}' frame`);
    }
    const socket = this.ws;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(this.frame(event, payload, seq));
      return;
    }
    // Not open yet: queue while a connection is expected (initial connect or
    // reconnect) and flush once the socket opens. Never retry blindly — each
    // queued frame is sent exactly once. In terminal states the frame is
    // dropped: the session is gone, so replaying it later would be stale.
    if (this.status === 'connecting' || this.status === 'reconnecting') {
      this.pending.push({ event, payload, seq });
    }
  }

  private frame(event: string, payload: unknown, seq: number): string {
    return JSON.stringify({
      version: PROTOCOL_VERSION,
      sessionId: this.sessionId,
      peerId: this.peerId,
      seq: seq,
      timestamp: Date.now(),
      event,
      payload
    });
  }

  private flushPending() {
    if (this.pending.length === 0) return;
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const frames = this.pending;
    this.pending = [];
    for (const f of frames) {
      socket.send(this.frame(f.event, f.payload, f.seq));
    }
  }

  onEvent(callback: EventCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Fired whenever lastAppliedEventSeq advances (catch-up position changes). */
  onSeqChange(callback: (seq: number) => void): () => void {
    this.seqListeners.add(callback);
    return () => this.seqListeners.delete(callback);
  }

  private notifySeq() {
    this.seqListeners.forEach((listener) => listener(this.lastAppliedEventSeq));
  }

  /**
   * Ask the server for whatever this client is missing: the full snapshot if
   * no base state has been applied yet, otherwise a replay after the last
   * applied seq (the server falls back to a snapshot if the range is gone).
   */
  private requestCatchUp() {
    this.send('state-request', {
      afterSeq: this.hasBase ? this.lastAppliedEventSeq : 0,
    });
  }

  private deliver(envelope: ServerEnvelope) {
    this.listeners.forEach((listener) => listener(envelope));
  }

  private applySequenced(envelope: ServerEnvelope) {
    this.lastAppliedEventSeq = envelope.seq;
    this.notifySeq();
    this.deliver(envelope);
  }

  /**
   * Apply buffered out-of-order events once the gap has been filled. Events
   * already covered by the catch-up (snapshot or replay) are dropped, then the
   * rest apply in seq order.
   */
  private drainPending() {
    for (const seq of [...this.pendingEvents.keys()]) {
      if (seq <= this.lastAppliedEventSeq) this.pendingEvents.delete(seq);
    }
    let next = this.lastAppliedEventSeq + 1;
    while (this.pendingEvents.has(next)) {
      const env = this.pendingEvents.get(next)!;
      this.pendingEvents.delete(next);
      this.applySequenced(env);
      next++;
    }
  }

  private trimPending() {
    // Safety cap against a pathological flood; the next catch-up request
    // covers everything after lastApplied, so nothing is lost permanently.
    const MAX_PENDING = 1000;
    while (this.pendingEvents.size > MAX_PENDING) {
      const oldest = Math.min(...this.pendingEvents.keys());
      this.pendingEvents.delete(oldest);
    }
  }

  disconnect() {
    this.pending = [];
    this.pendingEvents.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client initiated disconnect');
      this.ws = null;
    }
    this.setStatus('disconnected');
  }
}
