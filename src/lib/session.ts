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
