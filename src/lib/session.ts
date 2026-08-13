import { type ConnectionStatus, RealtimeClient } from './realtime';
import { type ServerEnvelope } from '../../shared/protocol';

export interface ClientSession {
  sessionId: string;
  peerId: string;
  role: 'a' | 'b';
}

const STORAGE_KEY = 'orbit.session';

export function persistSession(session: ClientSession) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage unavailable (private mode / quota) — the session just won't
    // survive a reload.
  }
}

export function loadSession(): ClientSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isClientSession(parsed)) return parsed;
    return null;
  } catch {
    // Malformed JSON or unavailable storage — treat as no session.
    return null;
  }
}

function isClientSession(value: unknown): value is ClientSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === 'string' &&
    typeof v.peerId === 'string' &&
    (v.role === 'a' || v.role === 'b')
  );
}

export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

/**
 * Wraps a RealtimeClient for one participant in a server session. It owns the
 * WebSocket only; the app-level BroadcastChannel (OrbitSync) is intentionally
 * left alone so local two-tab mode keeps working before/after a session.
 */
export class SessionManager {
  private ws: RealtimeClient | null = null;
  private listeners: Set<(env: ServerEnvelope) => void> = new Set();
  private statusListeners: Set<(s: ConnectionStatus) => void> = new Set();

  readonly sessionId: string;
  readonly peerId: string;
  readonly role: 'a' | 'b';

  constructor(session: ClientSession) {
    this.sessionId = session.sessionId;
    this.peerId = session.peerId;
    this.role = session.role;
    this.ws = new RealtimeClient(session.sessionId, session.peerId);

    this.ws.onEvent((env) => this.listeners.forEach((l) => l(env)));
    this.ws.onStatusChange((s) => this.statusListeners.forEach((l) => l(s)));
  }

  start() {
    this.ws?.connect();
  }

  stop() {
    this.ws?.disconnect();
  }

  get isConnected(): boolean {
    return this.ws?.isConnected || false;
  }

  send(event: string, payload: unknown, seq = 0) {
    this.ws?.send(event, payload, seq);
  }

  onEvent(callback: (env: ServerEnvelope) => void) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  onStatusChange(callback: (s: ConnectionStatus) => void) {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }
}
