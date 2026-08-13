import { parseClientEnvelope, parseServerEnvelope, PROTOCOL_VERSION, type ServerEnvelope } from '../../shared/protocol';

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
  private status: ConnectionStatus = 'idle';
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: number | null = null;
  // Outbound frames sent while the socket is (re)connecting. They are flushed
  // exactly once when the socket opens so a timer/chat/activity pressed right
  // around connection establishment is never silently dropped.
  private pending: { event: string; payload: unknown; seq: number }[] = [];

  constructor(sessionId: string, peerId: string) {
    this.sessionId = sessionId;
    this.peerId = peerId;
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
    const url = `${protocol}//${window.location.host}/ws?sessionId=${this.sessionId}&peerId=${this.peerId}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.setStatus('connected');
      this.reconnectAttempts = 0;
      this.flushPending();
    };

    this.ws.onmessage = (event) => {
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
      if (envelope) {
        this.listeners.forEach((listener) => listener(envelope));
      }
    };

    this.ws.onclose = (event) => {
      this.ws = null;
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
    this.ws.onerror = () => {
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

  disconnect() {
    this.pending = [];
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
