import type { ConnectionState } from './share';

const API_BASE = '';

export interface SessionResponse {
  id: string;
  code: string;
  expiresAt: number;
}

export interface JoinResponse {
  /** Present on the join-by-code response; the UUID-join caller already knows it. */
  sessionId?: string;
  peerId: string;
  role: 'a' | 'b';
}

/** Error thrown by API helpers; `status` is the HTTP status (null for network errors). */
export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === 'string') message = body.error;
  } catch {
    // Non-JSON body — keep the generic message.
  }
  return new ApiError(message, res.status);
}

export async function createSession(expiresIn = 3600): Promise<SessionResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
  } catch {
    throw new ApiError('Cannot reach the Orbit server', null);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<SessionResponse>;
}

export async function joinSession(
  sessionId: string,
  displayName: string,
  city: ConnectionState['a']['city'],
): Promise<JoinResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, city }),
    });
  } catch {
    throw new ApiError('Cannot reach the Orbit server', null);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<JoinResponse>;
}

export async function joinSessionByCode(
  code: string,
  displayName: string,
  city: ConnectionState['a']['city'],
): Promise<JoinResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/sessions/join-by-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName, city }),
    });
  } catch {
    throw new ApiError('Cannot reach the Orbit server', null);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<JoinResponse>;
}

export async function leaveSession(sessionId: string, peerId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/sessions/${sessionId}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId }),
    });
  } catch {
    throw new ApiError('Cannot reach the Orbit server', null);
  }
  if (!res.ok) throw await toApiError(res);
}

export async function getSession(sessionId: string) {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
  } catch {
    throw new ApiError('Cannot reach the Orbit server', null);
  }
  if (!res.ok) throw await toApiError(res);
  return res.json();
}
