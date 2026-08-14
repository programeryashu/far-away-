import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RealtimeClient, isTerminalCloseCode } from "./realtime";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState: number = FakeWebSocket.CONNECTING;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: "" });
  }

  open() {
    // A real WebSocket fires onopen exactly once; the outbound queue's
    // catch-up must not re-run on a repeated open() call.
    if (this.readyState === FakeWebSocket.OPEN) return;
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

const fakeWindow = {
  location: { protocol: "http:", host: "localhost:5173" },
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: unknown) => clearTimeout(id as number),
};

/** Wire-style frame with an explicit envelope seq. */
const wireFrame = (event: string, seq: number, payload: unknown) =>
  JSON.stringify({
    version: 1,
    sessionId: "s1",
    peerId: "p1",
    seq,
    timestamp: 123,
    event,
    payload,
  });

/** Full state snapshot frame with a snapshotSeq boundary. */
const stateFrame = (snapshotSeq: number) =>
  wireFrame("state", 0, {
    session: { id: "s1", code: "C1", status: "active", created_at: 1, expires_at: 9999, closed_at: null },
    peers: [],
    messages: [],
    canvas: null,
    timer: null,
    snapshotSeq,
  });

const sentEvents = (ws: FakeWebSocket): { event: string; payload: unknown }[] =>
  ws.sent.map((s) => JSON.parse(s));

describe("RealtimeClient", () => {
  let client: RealtimeClient;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("window", fakeWindow);
    vi.useFakeTimers();
    client = new RealtimeClient("s1", "p1");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects and reports connected", () => {
    const statuses: string[] = [];
    client.onStatusChange((s) => statuses.push(s));
    client.connect();
    expect(client.getStatus()).toBe("connecting");

    FakeWebSocket.instances[0].open();
    expect(client.getStatus()).toBe("connected");
    expect(statuses).toContain("connected");
  });

  it("treats a terminal close (4000-4999) as an error with no reconnect", () => {
    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close(4000);

    expect(client.getStatus()).toBe("error");
    // No reconnect timer was scheduled.
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);
  });

  it("reconnects with backoff after an abnormal close", () => {
    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close(1006);

    expect(client.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(3000);
    expect(FakeWebSocket.instances.length).toBe(2);
  });

  it("stops retrying after the attempt budget and reports disconnected", () => {
    client.connect();
    for (let i = 0; i < 6; i++) {
      FakeWebSocket.instances[i].close(1006);
      vi.advanceTimersByTime(60_000);
    }
    expect(client.getStatus()).toBe("disconnected");
  });

  it("sends envelopes the shared schema accepts", () => {
    client.connect();
    FakeWebSocket.instances[0].open();
    client.send("ping", { ts: 123 });

    const ping = sentEvents(FakeWebSocket.instances[0]).find((s) => s.event === "ping");
    expect(ping).toMatchObject({
      version: 1,
      sessionId: "s1",
      peerId: "p1",
      event: "ping",
      payload: { ts: 123 },
    });
  });

  it("requests a full snapshot on the first open (no base state yet)", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    const first = JSON.parse(socket.sent[0]);
    expect(first.event).toBe("state-request");
    expect(first.payload).toEqual({ afterSeq: 0 });
  });

  it("requests replay after the last applied seq on a reconnect", () => {
    client.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    expect(JSON.parse(ws1.sent[0]).payload).toEqual({ afterSeq: 0 });

    // Apply a snapshot (base) and two live sequenced events.
    ws1.onmessage?.({ data: stateFrame(2) });
    ws1.onmessage?.({ data: wireFrame("chat", 3, { id: "m3", peerId: "p2", sender: "Bob", text: "hi", seq: 2, timestamp: 1 }) });
    ws1.onmessage?.({ data: wireFrame("timer", 4, { action: "start", endAt: 1, remaining: 0 }) });

    // Abnormal close → reconnect → the new socket asks for replay after 4.
    ws1.close(1006);
    vi.advanceTimersByTime(3000);
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();

    const first = JSON.parse(ws2.sent[0]);
    expect(first.event).toBe("state-request");
    expect(first.payload).toEqual({ afterSeq: 4 });
  });

  it("applies contiguous sequenced events in order and reports the seq", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.onmessage?.({ data: stateFrame(0) });

    const received: string[] = [];
    const seqs: number[] = [];
    client.onEvent((env) => received.push(env.event));
    client.onSeqChange((seq) => seqs.push(seq));

    socket.onmessage?.({ data: wireFrame("timer", 1, { action: "start", endAt: 1, remaining: 0 }) });
    socket.onmessage?.({ data: wireFrame("chat", 2, { id: "m2", peerId: "p2", sender: "Bob", text: "yo", seq: 1, timestamp: 1 }) });

    expect(received).toEqual(["timer", "chat"]);
    expect(seqs).toEqual([1, 2]);
  });

  it("ignores duplicate seqs (applies each event exactly once)", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.onmessage?.({ data: stateFrame(0) });

    const received: string[] = [];
    client.onEvent((env) => received.push(env.event));

    socket.onmessage?.({ data: wireFrame("timer", 1, { action: "start", endAt: 1, remaining: 0 }) });
    // Same event again (live + replay overlap) — must be dropped.
    socket.onmessage?.({ data: wireFrame("timer", 1, { action: "start", endAt: 1, remaining: 0 }) });
    socket.onmessage?.({ data: wireFrame("cinema", 1, { playing: true }) });

    expect(received).toEqual(["timer"]);
  });

  it("buffers out-of-order events, requests catch-up, and drains once the gap fills", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.onmessage?.({ data: stateFrame(0) });

    const received: string[] = [];
    client.onEvent((env) => received.push(env.event));

    // seq 2 arrives before seq 1: buffered, catch-up requested.
    socket.onmessage?.({ data: wireFrame("timer", 2, { action: "start", endAt: 1, remaining: 0 }) });
    expect(received).toEqual([]);
    const catchUp = sentEvents(socket).filter((s) => s.event === "state-request");
    expect(catchUp).toHaveLength(2); // initial + gap-triggered

    // The missing event arrives (replay) → both apply in order.
    socket.onmessage?.({ data: wireFrame("cinema", 1, { playing: true }) });
    expect(received).toEqual(["cinema", "timer"]);
  });

  it("advances lastApplied from a snapshot and drops buffered duplicates", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.onmessage?.({ data: stateFrame(0) });

    const received: string[] = [];
    const seqs: number[] = [];
    client.onEvent((env) => received.push(env.event));
    client.onSeqChange((seq) => seqs.push(seq));

    // Gap: seq 3 buffered.
    socket.onmessage?.({ data: wireFrame("cinema", 3, { playing: true }) });
    expect(received).toEqual([]);

    // A snapshot covering the gap arrives → authoritative, drains the buffer.
    socket.onmessage?.({ data: stateFrame(3) });
    expect(seqs).toEqual([3]);
    expect(received).toEqual(["state"]); // buffered cinema was a duplicate of the snapshot
  });

  it("never moves lastApplied backwards from a stale snapshot", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.onmessage?.({ data: stateFrame(0) });

    // Apply a contiguous run of events up to seq 5.
    for (let i = 1; i <= 5; i++) {
      socket.onmessage?.({ data: wireFrame("timer", i, { action: "start", endAt: i, remaining: 0 }) });
    }

    const seqs: number[] = [];
    client.onSeqChange((seq) => seqs.push(seq));
    socket.onmessage?.({ data: stateFrame(3) });

    expect(seqs).toEqual([]); // 3 < 5 — no regression
  });

  it("queues a send made while connecting and flushes it exactly once on open", () => {
    // Reproduces the lost-first-action: a timer/chat sent immediately around
    // connection establishment, before the socket reaches OPEN.
    client.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);

    client.send("timer", { action: "start", endAt: 12345, remaining: 0 });

    // Nothing is transmitted while the socket is still connecting.
    expect(socket.sent).toHaveLength(0);

    // When the socket opens, catch-up goes first, then the queued action —
    // so the server logs the action after the replay boundary.
    socket.open();
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[0])).toMatchObject({ event: "state-request", payload: { afterSeq: 0 } });
    const sent = JSON.parse(socket.sent[1]);
    expect(sent.event).toBe("timer");
    expect(sent.payload).toEqual({ action: "start", endAt: 12345, remaining: 0 });
    expect(sent).toMatchObject({ version: 1, sessionId: "s1", peerId: "p1" });
  });

  it("queues each pre-open send once and never duplicates them", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    client.send("timer", { action: "start", endAt: 1, remaining: 0 });
    client.send("timer", { action: "pause", endAt: 0, remaining: 488 });
    client.send("chat", { id: "c1", text: "hi" });

    socket.open();
    expect(socket.sent).toHaveLength(4); // state-request + 3 queued actions
    const events = socket.sent.map((s) => JSON.parse(s).event);
    expect(events).toEqual(["state-request", "timer", "timer", "chat"]);

    // Nothing extra is flushed afterwards.
    socket.open();
    expect(socket.sent).toHaveLength(4);
  });

  it("queues sends made while reconnecting and flushes on the new socket", () => {
    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close(1006);
    expect(client.getStatus()).toBe("reconnecting");

    // User acts during the reconnect backoff — must not be dropped.
    client.send("timer", { action: "start", endAt: 99, remaining: 0 });

    vi.advanceTimersByTime(3000);
    const socket2 = FakeWebSocket.instances[1];
    expect(socket2).toBeDefined();
    expect(socket2.sent).toHaveLength(0);

    socket2.open();
    expect(socket2.sent).toHaveLength(2); // state-request + the queued action
    const action = sentEvents(socket2).find((s) => s.event === "timer");
    expect(action?.payload).toEqual({ action: "start", endAt: 99, remaining: 0 });
  });

  it("does not queue or replay sends after a terminal close", () => {
    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close(4000);
    expect(client.getStatus()).toBe("error");

    client.send("timer", { action: "start", endAt: 5, remaining: 0 });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(sentEvents(FakeWebSocket.instances[0]).filter((s) => s.event === "timer")).toHaveLength(0);
  });

  it("refuses to send a frame with a malformed payload", () => {
    client.connect();
    FakeWebSocket.instances[0].open();

    expect(() => client.send("ping", { ts: "not-a-number" })).toThrow();
    expect(() => client.send("chat", { text: 123 })).toThrow();
    expect(() => client.send("timer", { action: "jump", endAt: 1, remaining: 0 })).toThrow();
    expect(() => client.send("identity-update", { displayName: "A", city: { name: "Paris" } })).toThrow();

    // No invalid frame reached the socket (only the initial state-request).
    expect(sentEvents(FakeWebSocket.instances[0]).filter((s) => s.event !== "state-request")).toHaveLength(0);
  });

  it("does not queue an invalid frame while connecting", () => {
    client.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket.readyState).toBe(FakeWebSocket.CONNECTING);

    expect(() => client.send("cinema", { playing: "yes" })).toThrow();
    socket.open();
    expect(sentEvents(socket).filter((s) => s.event === "cinema")).toHaveLength(0);
  });

  it("delivers only schema-valid server envelopes to listeners", () => {
    const received: string[] = [];
    client.onEvent((env) => received.push(env.event));
    client.connect();
    const socket = FakeWebSocket.instances[0];

    const inbound = (event: string, payload?: unknown) =>
      JSON.stringify({
        version: 1,
        sessionId: "s1",
        peerId: "p1",
        seq: 0,
        timestamp: 123,
        event,
        payload,
      });

    // A valid server envelope is delivered.
    socket.onmessage?.({ data: inbound("peer-joined", { peerId: "p2", displayName: "Bob", cityJson: "{}" }) });
    // Unknown future events are parsed safely and dropped.
    socket.onmessage?.({ data: inbound("feature.future.v99", {}) });
    // Malformed payloads and non-JSON frames are dropped without crashing.
    socket.onmessage?.({ data: inbound("peer-joined", { peerId: 123 }) });
    socket.onmessage?.({ data: "this is not json" });
    // A server-only event sent from the wrong direction is dropped.
    socket.onmessage?.({ data: inbound("ping", { ts: 1 }) });

    expect(received).toEqual(["peer-joined"]);
  });
});

describe("isTerminalCloseCode", () => {
  it("accepts application close codes and rejects others", () => {
    expect(isTerminalCloseCode(4000)).toBe(true);
    expect(isTerminalCloseCode(4999)).toBe(true);
    expect(isTerminalCloseCode(1000)).toBe(false);
    expect(isTerminalCloseCode(1006)).toBe(false);
  });
});
