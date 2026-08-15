// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import App from './App';
import { FALLBACK_CITIES } from './lib/cities';
import { clearMomentCache } from './lib/moment';
import type { ServerMessage, ServerPeer } from './lib/reconcile';

// ---- mock the REST api so tests never touch fetch ----

const api = vi.hoisted(() => {
  class MockApiError extends Error {
    readonly status: number | null;
    constructor(message: string, status: number | null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    MockApiError,
    createSession: vi.fn(),
    joinSession: vi.fn(),
    joinSessionByCode: vi.fn(),
    leaveSession: vi.fn(),
  };
});

vi.mock('./lib/api', () => ({
  ApiError: api.MockApiError,
  createSession: api.createSession,
  joinSession: api.joinSession,
  joinSessionByCode: api.joinSessionByCode,
  leaveSession: api.leaveSession,
}));

// ---- mock the Shared Moment recommendation fetch (kept pending by default) ----
const momentApi = vi.hoisted(() => ({
  requestMomentRecommendation: vi.fn(),
}));

vi.mock('./lib/moment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/moment')>();
  return { ...actual, requestMomentRecommendation: momentApi.requestMomentRecommendation };
});

// ---- Fake WebSocket so the real RemoteConnection/RealtimeClient run in test ----

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: '' });
  }

  open() {
    if (this.readyState === FakeWebSocket.OPEN) return;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

// jsdom has no scrollIntoView; ChatBox calls it on message changes.
Element.prototype.scrollIntoView = () => {};

const lastWs = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const sentEvents = (ws: FakeWebSocket) => ws.sent.map((s) => JSON.parse(s) as { event: string; payload: Record<string, unknown> });

const env = (event: string, payload: unknown, seq = 0) => ({
  version: 1,
  sessionId: 's1',
  peerId: 'p1',
  seq,
  timestamp: Date.now(),
  event,
  payload,
});

const cityJson = JSON.stringify(FALLBACK_CITIES[0]); // San Francisco

const stateFrame = (opts: { snapshotSeq?: number; messages?: ServerMessage[]; peers?: ServerPeer[] } = {}) =>
  env('state', {
    session: {
      id: 's1',
      code: 'ABC123',
      status: 'active',
      created_at: 1,
      expires_at: 9_999_999_999,
      closed_at: null,
    },
    peers: opts.peers ?? [],
    messages: opts.messages ?? [],
    canvas: null,
    timer: null,
    snapshotSeq: opts.snapshotSeq ?? 0,
  });

const chatFrame = (id: string, text: string, seq: number, sender = 'Bob', peerId = 'p2') =>
  env('chat', { id, peerId, sender, text, seq, timestamp: Date.now() }, seq);

const aNameInput = () => document.getElementById('username-Host Terminal (User A)') as HTMLInputElement;
const bNameInput = () => document.getElementById('username-Remote Node (User B)') as HTMLInputElement;

describe('App session state machine', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('WebSocket', FakeWebSocket);
    api.createSession.mockReset();
    api.joinSession.mockReset();
    api.joinSessionByCode.mockReset();
    api.leaveSession.mockReset();
    clearMomentCache();
    // Shared Moment requests stay pending unless a test resolves one.
    momentApi.requestMomentRecommendation.mockImplementation(() => new Promise<never>(() => {}));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    momentApi.requestMomentRecommendation.mockReset();
  });

  it('renders local mode by default with no leave button', () => {
    render(<App />);
    expect(screen.getByText('Local mode')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /leave the current session/i })).toBeNull();
    // Both sides are editable in local mode.
    expect(aNameInput().disabled).toBe(false);
    expect(bNameInput().disabled).toBe(false);
  });

  it('creates a session as A, connects, sees the peer, then leaves back to local mode', async () => {
    api.createSession.mockResolvedValue({ id: 's1', code: 'ABC123', expiresAt: Date.now() + 3_600_000 });
    api.joinSession.mockResolvedValue({ peerId: 'p1', role: 'a' });
    api.leaveSession.mockResolvedValue(undefined);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /copy shareable connection link/i }));

    // Joining → connected once the socket opens.
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => lastWs().open());
    await waitFor(() => expect(screen.getByText('Connected · waiting for peer')).toBeTruthy());

    // Presence stays distinct from connection status.
    act(() => lastWs().emit(env('peer-joined', { peerId: 'p2', displayName: 'Kimi', cityJson })));
    await waitFor(() => expect(screen.getByText('Connected · peer online')).toBeTruthy());
    act(() => lastWs().emit(env('peer-left', { peerId: 'p2' })));
    await waitFor(() => expect(screen.getByText('Connected · waiting for peer')).toBeTruthy());

    // A owns side A: B's panel is read-only.
    expect(bNameInput().disabled).toBe(true);
    expect(aNameInput().disabled).toBe(false);

    // Leave: session metadata cleared, local app data kept, UI back to local.
    fireEvent.click(screen.getByRole('button', { name: /leave the current session/i }));
    await waitFor(() => expect(screen.getByText('Local mode')).toBeTruthy());
    expect(api.leaveSession).toHaveBeenCalledWith('s1', 'p1');
    expect(localStorage.getItem('orbit.session')).toBeNull();
    expect(JSON.parse(localStorage.getItem('faraway.connection') ?? '{}').a.name).toBe('Yash');
    expect(aNameInput().value).toBe('Yash');
    expect(screen.queryByRole('button', { name: /leave the current session/i })).toBeNull();

    // The server kicks the socket during leave; a close landing after the UI
    // has already returned to local mode must not override that state.
    act(() => FakeWebSocket.instances[0].close(1000));
    expect(screen.getByText('Local mode')).toBeTruthy();
    expect(screen.queryByText('Disconnected')).toBeNull();
  });

  it('joins as B via invite: role applied, peer identity applied, presence live', async () => {
    window.history.replaceState(null, '', '/?session=s1');
    api.joinSession.mockResolvedValue({ peerId: 'p2', role: 'b' });

    render(<App />);
    expect(screen.getByText('Joining…')).toBeTruthy();
    expect(screen.getByText("You've been invited to a live session")).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /join session/i }));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => lastWs().open());
    await waitFor(() => expect(screen.getByText('Connected · waiting for peer')).toBeTruthy());

    // Role b: A's panel is read-only, B's is editable.
    expect(aNameInput().disabled).toBe(true);
    expect(bNameInput().disabled).toBe(false);

    // Remote identity from the live peer lands on the peer's side (A).
    act(() => lastWs().emit(env('peer-joined', { peerId: 'p1', displayName: 'Yash', cityJson })));
    await waitFor(() => expect(aNameInput().value).toBe('Yash'));
    expect(screen.getByText('Connected · peer online')).toBeTruthy();

    act(() => lastWs().emit(env('peer-left', { peerId: 'p1' })));
    await waitFor(() => expect(screen.getByText('Connected · waiting for peer')).toBeTruthy());
  });

  it('shows a friendly error for an invalid/expired invite and never raw server text', async () => {
    window.history.replaceState(null, '', '/?code=NOPE');
    api.joinSessionByCode.mockRejectedValue(new api.MockApiError('session not found', 404));

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /join session/i }));

    await waitFor(() => expect(screen.getAllByText('Session unavailable').length).toBeGreaterThan(0));
    expect(screen.getByText('This invite is invalid or has expired.')).toBeTruthy();
    expect(screen.queryByText(/session not found/i)).toBeNull();

    // Leaving the error returns to local mode.
    fireEvent.click(screen.getByRole('button', { name: /^leave session/i }));
    await waitFor(() => expect(screen.getByText('Local mode')).toBeTruthy());
  });

  it('reports a full session as a friendly 409 message', async () => {
    window.history.replaceState(null, '', '/?session=s1');
    api.joinSession.mockRejectedValue(new api.MockApiError('session full', 409));

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /join session/i }));

    await waitFor(() => expect(screen.getByText('This session is already full.')).toBeTruthy());
  });

  it('does NOT fall back to local mode when the backend is unreachable for an invitee', async () => {
    window.history.replaceState(null, '', '/?session=s1');
    api.joinSession.mockRejectedValue(new api.MockApiError('Cannot reach the Orbit server', null));

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /join session/i }));

    await waitFor(() =>
      expect(
        screen.getByText('Cannot reach the Orbit server. Make sure the backend is running, then try again.'),
      ).toBeTruthy(),
    );
    expect(screen.queryByText('Local mode')).toBeNull();
  });

  it('falls back to the local share link when the backend is unreachable for the creator', async () => {
    api.createSession.mockRejectedValue(new api.MockApiError('Cannot reach the Orbit server', null));

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /copy shareable connection link/i }));

    await waitFor(() => expect(screen.getByText('Local mode')).toBeTruthy());
    expect(screen.getByText(/copy this link manually/i)).toBeTruthy();
    expect(screen.getByText(/a=Yash/)).toBeTruthy();
  });

  it('reconnects after a drop without duplicating the connection or messages', async () => {
    vi.useFakeTimers();
    localStorage.setItem('orbit.session', JSON.stringify({ sessionId: 's1', peerId: 'p1', role: 'a' }));
    render(<App />);
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws1 = lastWs();
    act(() => ws1.open());
    expect(screen.getByText('Connected · waiting for peer')).toBeTruthy();

    // Send a chat while connected.
    const input = screen.getByLabelText(/Message Kimi/);
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    expect(screen.getAllByText('hello')).toHaveLength(1);

    // Abnormal close → reconnecting.
    act(() => ws1.close(1006));
    expect(screen.getByText('Reconnecting…')).toBeTruthy();

    // Backoff elapses → exactly one new socket.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const ws2 = lastWs();
    act(() => ws2.open());
    expect(screen.getByText('Connected · waiting for peer')).toBeTruthy();

    // No duplicate connection, no duplicate messages, catch-up requested.
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(screen.getAllByText('hello')).toHaveLength(1);
    expect(JSON.parse(ws2.sent[0]).event).toBe('state-request');
  });

  it('shows disconnected after the reconnect budget is exhausted', async () => {
    vi.useFakeTimers();
    localStorage.setItem('orbit.session', JSON.stringify({ sessionId: 's1', peerId: 'p1', role: 'a' }));
    render(<App />);
    act(() => lastWs().open());

    for (let i = 0; i < 6; i++) {
      act(() => lastWs().close(1006));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    }
    expect(screen.getByText('Disconnected')).toBeTruthy();
    expect(FakeWebSocket.instances).toHaveLength(6);
  });

  it('treats a terminal server rejection as an error with no retry', async () => {
    vi.useFakeTimers();
    localStorage.setItem('orbit.session', JSON.stringify({ sessionId: 's1', peerId: 'p1', role: 'a' }));
    render(<App />);
    act(() => lastWs().open());

    act(() => lastWs().close(4000));
    expect(screen.getAllByText('Session unavailable').length).toBeGreaterThan(0);
    expect(screen.getByText(/no longer available/i)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('persists lastAppliedEventSeq, dedupes across a reload, and continues live events', async () => {
    localStorage.setItem(
      'orbit.session',
      JSON.stringify({ sessionId: 's1', peerId: 'p1', role: 'a', lastAppliedEventSeq: 4 }),
    );
    const msgs: ServerMessage[] = [1, 2, 3, 4, 5].map((i) => ({
      id: `msg-${i}`,
      session_id: 's1',
      sender_peer: 'p2',
      sender_name: 'Bob',
      text: `history ${i}`,
      ts: i,
      seq: i,
    }));

    const first = render(<App />);
    const ws1 = lastWs();
    act(() => ws1.open());

    // A stale live event at/below the persisted floor is dropped before the
    // snapshot establishes base state.
    act(() => ws1.emit(chatFrame('msg-4', 'stale', 4)));
    act(() => ws1.emit(stateFrame({ snapshotSeq: 5, messages: msgs })));
    await waitFor(() => expect(screen.getByText('history 5')).toBeTruthy());
    expect(screen.queryByText('stale')).toBeNull();

    // Live event seq 6 applies exactly once; a duplicate frame is ignored.
    act(() => ws1.emit(chatFrame('msg-6', 'live six', 6)));
    act(() => ws1.emit(chatFrame('msg-6', 'live six', 6)));
    await waitFor(() => expect(screen.getAllByText('live six')).toHaveLength(1));

    // A repeated identical snapshot does not duplicate history.
    act(() => ws1.emit(stateFrame({ snapshotSeq: 5, messages: msgs })));
    expect(screen.getAllByText('history 3')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('orbit.session') ?? '{}').lastAppliedEventSeq).toBe(6);

    // Reload: a fresh page with the persisted position must not duplicate
    // anything the previous page already applied.
    first.unmount();
    render(<App />);
    const ws2 = lastWs();
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => ws2.open());

    // Replayed seq 6 (already applied before reload) is dropped, not re-shown.
    act(() => ws2.emit(chatFrame('msg-6', 'live six', 6)));
    act(() => ws2.emit(stateFrame({ snapshotSeq: 6, messages: [...msgs, { ...msgs[4], id: 'msg-6', text: 'live six' }] })));
    await waitFor(() => expect(screen.getAllByText('live six')).toHaveLength(1));
    expect(screen.getAllByText('history 3')).toHaveLength(1);

    // Live events continue at the next seq and persist the new position.
    act(() => ws2.emit(chatFrame('msg-7', 'after reload', 7)));
    await waitFor(() => expect(screen.getAllByText('after reload')).toHaveLength(1));
    expect(JSON.parse(localStorage.getItem('orbit.session') ?? '{}').lastAppliedEventSeq).toBe(7);
  });

  it('debounces own identity to exactly one update, applies the peer identity, and blocks editing the peer', async () => {
    vi.useFakeTimers();
    localStorage.setItem('orbit.session', JSON.stringify({ sessionId: 's1', peerId: 'p1', role: 'a' }));
    const { unmount } = render(<App />);
    const ws = lastWs();
    act(() => ws.open());

    // A owns side A; B's panel is read-only (A cannot modify B).
    expect(bNameInput().disabled).toBe(true);

    // Rapid edits collapse into one debounced identity-update.
    fireEvent.change(aNameInput(), { target: { value: 'Alic' } });
    fireEvent.change(aNameInput(), { target: { value: 'Alicia' } });
    expect(sentEvents(ws).filter((s) => s.event === 'identity-update')).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    const updates = sentEvents(ws).filter((s) => s.event === 'identity-update');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({
      displayName: 'Alicia',
      city: expect.objectContaining({ name: 'San Francisco' }),
    });

    // The peer's identity update lands on the peer's side. peer-updated is a
    // sequenced event, so it needs a seq above the client's applied floor.
    act(() => lastWs().emit(env('peer-updated', { peerId: 'p2', displayName: 'Kimi2', cityJson }, 1)));
    expect(bNameInput().value).toBe('Kimi2');

    // Identity survived in local storage; a fresh local-mode load restores it.
    unmount();
    localStorage.removeItem('orbit.session');
    render(<App />);
    expect(aNameInput().value).toBe('Alicia');
  });

  it('puts a validated chat frame on the wire and dedupes inbound history', async () => {
    api.createSession.mockResolvedValue({ id: 's1', code: 'ABC123', expiresAt: Date.now() + 3_600_000 });
    api.joinSession.mockResolvedValue({ peerId: 'p1', role: 'a' });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /copy shareable connection link/i }));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => lastWs().open());
    await waitFor(() => expect(screen.getByText('Connected · waiting for peer')).toBeTruthy());

    const input = screen.getByLabelText(/Message Kimi/);
    fireEvent.change(input, { target: { value: 'hi there' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(screen.getAllByText('hi there')).toHaveLength(1));

    // The outbound frame carries the sender's display name and a local id.
    const chat = sentEvents(lastWs()).find((s) => s.event === 'chat');
    expect(chat).toBeTruthy();
    expect(chat!.payload).toMatchObject({ sender: 'Yash', text: 'hi there' });
    expect(typeof chat!.payload.id).toBe('string');

    // History replay containing our own message (same id) must not duplicate it.
    act(() => lastWs().emit(chatFrame(chat!.payload.id as string, 'hi there', 1, 'Bob')));
    await waitFor(() => expect(screen.getAllByText('hi there')).toHaveLength(1));
  });

  it('starts a recommended shared activity via Shared Moment Start Together', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T01:00:00Z'));
    momentApi.requestMomentRecommendation.mockResolvedValue({
      source: 'deterministic',
      recommendation: {
        activity: 'timer',
        durationMinutes: 45,
        title: 'Focus together',
        explanation: 'A comfortable overlap — run a shared focus session.',
      },
    });

    render(<App />);
    // The deterministic facts render instantly; flush the recommendation.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: /start together/i }));
    // Flush the launch effect that opens the activity and starts the timer.
    await act(async () => {
      await Promise.resolve();
    });

    // The existing realtime system (not a special AI transport) executed it:
    // the shared focus timer opened with a running countdown.
    expect(screen.getByText('Deep Space Cafe & Focus Timer')).toBeTruthy();
    expect(screen.getByText(/shared focus session started on your device/i)).toBeTruthy();
  });
});
