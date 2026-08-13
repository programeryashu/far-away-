import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LocalConnection,
  RemoteConnection,
  createConnection,
} from './connection';
import { OrbitSync } from './broadcast';
import type { ClientSession } from './session';
import type { ChatSendPayload, PingPayload, ServerEnvelope } from '../../shared/protocol';

// --- In-memory BroadcastChannel so two OrbitSyncs can talk like two tabs ---

class FakeBroadcastChannel {
  static registry = new Map<string, Set<FakeBroadcastChannel>>();

  readonly name: string;
  private listeners = new Set<(event: { data: unknown }) => void>();
  private closed = false;

  constructor(name: string) {
    this.name = name;
    if (!FakeBroadcastChannel.registry.has(name)) {
      FakeBroadcastChannel.registry.set(name, new Set());
    }
    FakeBroadcastChannel.registry.get(name)!.add(this);
  }

  postMessage(data: unknown) {
    if (this.closed) return;
    for (const other of FakeBroadcastChannel.registry.get(this.name) ?? []) {
      if (other !== this && !other.closed) {
        for (const fn of other.listeners) fn({ data });
      }
    }
  }

  addEventListener(_type: string, fn: (event: { data: unknown }) => void) {
    this.listeners.add(fn);
  }

  removeEventListener(_type: string, fn: (event: { data: unknown }) => void) {
    this.listeners.delete(fn);
  }

  close() {
    this.closed = true;
    FakeBroadcastChannel.registry.get(this.name)?.delete(this);
    this.listeners.clear();
  }

  static reset() {
    FakeBroadcastChannel.registry.clear();
  }
}

function createFakeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

// --- Fake WebSocket for the remote transport ---

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
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
    this.readyState = 3;
    this.onclose?.({ code });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

const frame = (event: string, payload?: unknown) => ({
  version: 1,
  sessionId: 's1',
  peerId: 'p1',
  seq: 0,
  timestamp: 123,
  event,
  payload,
});

describe('LocalConnection', () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
    FakeWebSocket.instances = [];
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('localStorage', createFakeStorage());
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5173' },
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      clearInterval: (id: number) => clearInterval(id),
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: number) => clearTimeout(id),
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function twoTabs() {
    const syncA = new OrbitSync();
    const syncB = new OrbitSync();
    const connA = new LocalConnection(syncA);
    const connB = new LocalConnection(syncB);
    connA.start();
    connB.start();
    return { connA, connB };
  }

  it('derives roles from the tab side: first tab is a, second is b', () => {
    const { connA, connB } = twoTabs();
    expect(connA.role).toBe('a');
    expect(connB.role).toBe('b');
  });

  it('delivers chat/canvas/timer/cinema between two tabs exactly once', () => {
    const { connA, connB } = twoTabs();
    const received: ServerEnvelope[] = [];
    connB.onEvent((e) => received.push(e));

    connA.send('chat', { id: 'c1', sender: 'Alice', text: 'hi' });
    connA.send('cinema', { playing: true });
    connA.send('timer', { action: 'start', endAt: 1000, remaining: 0 });
    connA.send('canvas-stroke', { points: [{ x: 1, y: 2 }], color: '#fff' });
    connA.send('canvas-clear', {});

    expect(received.map((e) => e.event)).toEqual([
      'chat',
      'cinema',
      'timer',
      'canvas-stroke',
      'canvas-clear',
    ]);
    const chat = received[0];
    if (chat.event === 'chat') {
      expect(chat.payload.text).toBe('hi');
      expect(chat.payload.sender).toBe('Alice');
      expect(chat.payload.id).toBe('c1');
    }
    const timer = received[2];
    if (timer.event === 'timer') {
      expect(timer.payload).toEqual({ action: 'start', endAt: 1000, remaining: 0 });
    }
  });

  it('round-trips in the B→A direction too', () => {
    const { connA, connB } = twoTabs();
    const received: ServerEnvelope[] = [];
    connA.onEvent((e) => received.push(e));

    connB.send('chat', { id: 'c2', sender: 'Bob', text: 'hello back' });
    connB.send('timer', { action: 'pause', endAt: 0, remaining: 488 });

    expect(received.map((e) => e.event)).toEqual(['chat', 'timer']);
  });

  it('answers a ping exactly once (sender ignores its own echo)', () => {
    const { connA } = twoTabs();
    const pongs: ServerEnvelope[] = [];
    connA.onEvent((e) => {
      if (e.event === 'pong') pongs.push(e);
    });

    const ts = Date.now();
    connA.send('ping', { ts });

    expect(pongs).toHaveLength(1);
    if (pongs[0]?.event === 'pong') {
      expect(pongs[0].payload.ts).toBe(ts);
    }
  });

  it('simulates a pong in solo local mode', () => {
    const conn = new LocalConnection(new OrbitSync());
    conn.start();
    const pongs: ServerEnvelope[] = [];
    conn.onEvent((e) => {
      if (e.event === 'pong') pongs.push(e);
    });

    conn.send('ping', { ts: 42 });
    expect(pongs).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(pongs).toHaveLength(1);
    if (pongs[0]?.event === 'pong') {
      expect(pongs[0].payload.ts).toBe(42);
    }
  });

  it('reports status and live peer presence', () => {
    const syncA = new OrbitSync();
    const syncB = new OrbitSync();
    const connA = new LocalConnection(syncA);
    const connB = new LocalConnection(syncB);

    const statuses: string[] = [];
    connA.onStatus((s) => statuses.push(s));
    connA.start();
    expect(statuses).toContain('connected');

    const peers: boolean[] = [];
    connA.onPeerChange((h) => peers.push(h));
    expect(peers[peers.length - 1]).toBe(false);

    // B starts → A sees a live peer.
    connB.start();
    expect(peers).toEqual([false, true]);

    connA.stop();
    expect(statuses).toContain('disconnected');
  });

  it('never delivers an invalid outbound frame on the local channel', () => {
    const { connA, connB } = twoTabs();
    const received: ServerEnvelope[] = [];
    connB.onEvent((e) => received.push(e));

    connA.send('ping', { ts: 'not-a-number' } as unknown as PingPayload);
    expect(received).toHaveLength(0);
  });

  it('selects the right transport via createConnection', () => {
    const sync = new OrbitSync();
    const session: ClientSession = { sessionId: 's1', peerId: 'p1', role: 'a' };

    const local = createConnection(sync, null);
    expect(local.mode).toBe('local');

    const remote = createConnection(sync, session);
    expect(remote.mode).toBe('remote');
    if (remote.mode === 'remote') {
      expect(remote.role).toBe('a');
    }
  });
});

describe('RemoteConnection', () => {
  const session: ClientSession = { sessionId: 's1', peerId: 'p1', role: 'a' };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', {
      location: { protocol: 'http:', host: 'localhost:5173' },
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (id: number) => clearTimeout(id),
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('forwards status and events from the realtime client', () => {
    const conn = new RemoteConnection(session);
    const statuses: string[] = [];
    conn.onStatus((s) => statuses.push(s));
    conn.start();
    expect(statuses).toContain('connecting');

    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(statuses).toContain('connected');

    const events: ServerEnvelope[] = [];
    conn.onEvent((e) => events.push(e));
    ws.emit(
      frame('connected', { sessionId: 's1', peerId: 'p1', role: 'a' }),
    );
    expect(events.map((e) => e.event)).toEqual(['connected']);

    ws.close(4000);
    expect(statuses).toContain('error');
  });

  it('sends validated envelopes and throws on invalid payloads', () => {
    const conn = new RemoteConnection(session);
    conn.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    conn.send('ping', { ts: 5 });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ event: 'ping', payload: { ts: 5 } });

    expect(() =>
      conn.send('chat', { text: 123 } as unknown as ChatSendPayload),
    ).toThrow();
    expect(ws.sent).toHaveLength(1);
  });

  it('derives peer presence from peer events, deduping and ignoring self', () => {
    const conn = new RemoteConnection(session);
    const peers: boolean[] = [];
    conn.onPeerChange((h) => peers.push(h));
    conn.start();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    ws.emit(frame('peer-joined', { peerId: 'p2', displayName: 'Bob', cityJson: '{}' }));
    ws.emit(frame('peer-joined', { peerId: 'p1', displayName: 'Alice', cityJson: '{}' }));
    ws.emit(frame('peer-joined', { peerId: 'p2', displayName: 'Bob', cityJson: '{}' }));
    ws.emit(frame('peer-left', { peerId: 'p2' }));

    expect(peers).toEqual([false, true, false]);
  });
});
