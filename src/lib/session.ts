export interface ClientSession {
  sessionId: string;
  peerId: string;
  role: 'a' | 'b';
  /**
   * Human-friendly share code (from the create-session response). Persisted so
   * a reload can re-share the same short link; absent for legacy sessions that
   * predate code sharing, which fall back to the session UUID.
   */
  code?: string;
  /**
   * Last server session event seq this client applied. Session metadata only
   * (never sent to the server as authoritative) — it lets a reconnect resume
   * replay from where this device left off.
   */
  lastAppliedEventSeq?: number;
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
    (v.role === 'a' || v.role === 'b') &&
    (v.code === undefined || typeof v.code === 'string') &&
    (v.lastAppliedEventSeq === undefined ||
      (typeof v.lastAppliedEventSeq === 'number' && v.lastAppliedEventSeq >= 0))
  );
}

export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing to clear.
  }
}
