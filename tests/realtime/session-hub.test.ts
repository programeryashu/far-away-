import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionHub } from "../../server/realtime/session-hub.js";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { parseEnvelope } from "../../shared/protocol.js";

class MockSocket extends EventEmitter {
  readyState = 1;
  send = vi.fn();
}

let uuidCounter = 0;
vi.mock("node:crypto", () => ({
  randomUUID: () => `mock-uuid-${++uuidCounter}`,
}));

describe("SessionHub", () => {
  let hub: SessionHub;
  let eventSeqCounter = 0;
  const mockFastify = { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;
  const mockStore = {
    getPeer: vi.fn(),
    updatePeerLastSeen: vi.fn(),
    getNextSequence: vi.fn().mockReturnValue(1),
    addMessage: vi.fn(),
    upsertTimerState: vi.fn(),
    upsertCinemaState: vi.fn(),
    updatePeerIdentity: vi.fn(),
    updateCanvasSnapshot: vi.fn(),
    getCanvasSnapshot: vi.fn().mockReturnValue(null),
    appendEvent: vi.fn(),
    getLatestEventSeq: vi.fn().mockReturnValue(0),
    getEventsAfterSeq: vi.fn().mockReturnValue([]),
    getSessionState: vi.fn().mockReturnValue({
      session: { id: "s1", code: "C1", status: "active", created_at: 1, expires_at: 9999, closed_at: null },
      peers: [],
      messages: [],
      canvas: null,
      timer: null,
      cinema: null,
    }),
  };
  Object.assign(mockFastify, { store: mockStore });

  beforeEach(() => {
    uuidCounter = 0;
    eventSeqCounter = 0;
    vi.clearAllMocks();
    mockStore.appendEvent.mockImplementation(() => ++eventSeqCounter);
    hub = new SessionHub(mockFastify);
    mockStore.getPeer.mockReturnValue({ id: "p1", session_id: "s1", role: "a", display_name: "Alice", city_json: "{}" });
  });

  it("should track connections", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);
    expect(hub.activeConnections).toBe(1);
  });

  it("should broadcast to other connections", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    const id1 = hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    hub.broadcastToSession(
      "s1",
      { event: "chat", payload: { id: "m1", peerId: "p1", sender: "Alice", text: "hi", seq: 1, timestamp: 123 } },
      id1,
    );
    expect(socket1.send).not.toHaveBeenCalled();
    expect(socket2.send).toHaveBeenCalled();
  });

  it("should send full protocol envelopes the client schema accepts", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    const senderId = hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    hub.broadcastToSession(
      "s1",
      { event: "chat", payload: { id: "m1", peerId: "p1", sender: "Alice", text: "hi", seq: 1, timestamp: 123 } },
      senderId,
    );

    const sent = JSON.parse(socket2.send.mock.calls[0][0]);
    expect(parseEnvelope(sent)).not.toBeNull();
    expect(sent.event).toBe("chat");
    expect(sent.sessionId).toBe("s1");
    expect(sent.peerId).toBe("p2");
  });

  it("drops an outbound frame that fails the server envelope schema", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    const senderId = hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    // A client-style chat payload is not a valid server broadcast payload —
    // the hub must refuse to send it rather than emit a frame the client
    // would drop.
    hub.broadcastToSession("s1", { event: "chat", payload: { text: "hi" } }, senderId);
    expect(socket2.send).not.toHaveBeenCalled();
  });

  it("should echo the ping timestamp in the pong", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);

    vi.clearAllMocks();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "ping",
          payload: { ts: 456 },
        }),
      ),
    );

    const sent = JSON.parse(socket.send.mock.calls[0][0]);
    expect(parseEnvelope(sent)).not.toBeNull();
    expect(sent.event).toBe("pong");
    expect(sent.payload.ts).toBe(456);
  });

  it("should include the sender display name in chat broadcasts", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    socket1.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "chat",
          payload: { text: "hello" },
        }),
      ),
    );

    const sent = JSON.parse(socket2.send.mock.calls[0][0]);
    expect(sent.event).toBe("chat");
    expect(sent.payload.sender).toBe("Alice");
    expect(sent.payload.text).toBe("hello");
  });

  it("should relay cinema events to the other connection", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    socket1.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "cinema",
          payload: { playing: true },
        }),
      ),
    );

    const sent = JSON.parse(socket2.send.mock.calls[0][0]);
    expect(parseEnvelope(sent)).not.toBeNull();
    expect(sent.event).toBe("cinema");
    expect(sent.payload).toEqual({ playing: true });
  });

  it("should reject an invalid cinema payload", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);

    vi.clearAllMocks();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "cinema",
          payload: { playing: "yes" },
        }),
      ),
    );

    const sent = JSON.parse(socket.send.mock.calls[0][0]);
    expect(sent.event).toBe("error");
    expect(sent.payload.message).toContain("cinema");
  });

  it("should persist and relay timer state", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    socket1.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "timer",
          payload: { action: "start", endAt: 1000, remaining: 0 },
        }),
      ),
    );

    expect(mockStore.upsertTimerState).toHaveBeenCalledWith("s1", "start", 1000, 0);
    const sent = JSON.parse(socket2.send.mock.calls[0][0]);
    expect(sent.event).toBe("timer");
    expect(sent.payload).toEqual({ action: "start", endAt: 1000, remaining: 0 });
  });

  it("logs every sequenced event and stamps the broadcast envelope with its seq", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    const send = (event: string, payload: unknown) =>
      socket1.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            version: 1,
            sessionId: "s1",
            peerId: "p1",
            seq: 0,
            timestamp: 123,
            event,
            payload,
          }),
        ),
      );

    send("timer", { action: "start", endAt: 1000, remaining: 0 });
    send("canvas-stroke", { points: [{ x: 1, y: 2 }], color: "#fff" });
    send("canvas-clear", {});
    send("cinema", { playing: true });
    send("chat", { text: "hi" });

    // Every event was appended to the durable log with the right name.
    expect(mockStore.appendEvent).toHaveBeenNthCalledWith(1, "s1", "timer", expect.any(String));
    expect(mockStore.appendEvent).toHaveBeenNthCalledWith(2, "s1", "canvas-stroke", expect.any(String));
    expect(mockStore.appendEvent).toHaveBeenNthCalledWith(3, "s1", "canvas-clear", expect.any(String));
    expect(mockStore.appendEvent).toHaveBeenNthCalledWith(4, "s1", "cinema", expect.any(String));
    expect(mockStore.appendEvent).toHaveBeenNthCalledWith(5, "s1", "chat", expect.any(String));

    // The chat log payload is the server broadcast shape, not the send shape.
    const chatLogPayload = JSON.parse(mockStore.appendEvent.mock.calls[4][2]);
    expect(chatLogPayload).toMatchObject({ sender: "Alice", text: "hi" });
    expect(typeof chatLogPayload.id).toBe("string");
    expect(chatLogPayload.peerId).toBe("p1");

    // Broadcast envelopes carry the allocated event seq (1..5 in order).
    const sentEvents = socket2.send.mock.calls.map((c) => JSON.parse(c[0]));
    expect(sentEvents.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(sentEvents.map((f) => f.event)).toEqual(["timer", "canvas-stroke", "canvas-clear", "cinema", "chat"]);
    expect(parseEnvelope(sentEvents[0])).not.toBeNull();
  });

  it("replays events after the requested seq in order on state-request", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);
    mockStore.getLatestEventSeq.mockReturnValue(5);
    mockStore.getEventsAfterSeq.mockReturnValue([
      { id: 3, session_id: "s1", seq: 3, event: "chat", payload_json: JSON.stringify({ id: "m3", peerId: "p2", sender: "Bob", text: "yo", seq: 2, timestamp: 1 }), created_at: 100 },
      { id: 4, session_id: "s1", seq: 4, event: "timer", payload_json: JSON.stringify({ action: "start", endAt: 1, remaining: 0 }), created_at: 200 },
      { id: 5, session_id: "s1", seq: 5, event: "cinema", payload_json: JSON.stringify({ playing: true }), created_at: 300 },
    ]);

    vi.clearAllMocks();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "state-request",
          payload: { afterSeq: 2 },
        }),
      ),
    );

    // Replay frames preserve their original seqs and order; no snapshot sent.
    const sent = socket.send.mock.calls.map((c) => JSON.parse(c[0]));
    expect(sent.map((f) => f.event)).toEqual(["chat", "timer", "cinema"]);
    expect(sent.map((f) => f.seq)).toEqual([3, 4, 5]);
    expect(sent[0].payload.text).toBe("yo");
    expect(sent[0].timestamp).toBe(100); // original event time preserved
    expect(sent.every((f) => parseEnvelope(f))).toBe(true);
  });

  it("sends a full snapshot when the requested range is not contiguous", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);
    mockStore.getLatestEventSeq.mockReturnValue(5);
    // Range starts at 4, but afterSeq 2 implies 3 is missing — pruned/gapped.
    mockStore.getEventsAfterSeq.mockReturnValue([
      { id: 4, session_id: "s1", seq: 4, event: "chat", payload_json: "{}", created_at: 1 },
    ]);

    vi.clearAllMocks();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "state-request",
          payload: { afterSeq: 2 },
        }),
      ),
    );

    expect(mockStore.getSessionState).toHaveBeenCalledWith("s1");
    const sent = JSON.parse(socket.send.mock.calls[0][0]);
    expect(sent.event).toBe("state");
    expect(sent.payload.snapshotSeq).toBe(5);
    expect(parseEnvelope(sent)).not.toBeNull();
  });

  it("always sends a full snapshot to a fresh client (afterSeq 0)", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);
    mockStore.getLatestEventSeq.mockReturnValue(9);
    mockStore.getEventsAfterSeq.mockReturnValue([
      { id: 1, session_id: "s1", seq: 1, event: "chat", payload_json: "{}", created_at: 1 },
    ]);

    vi.clearAllMocks();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "state-request",
          payload: { afterSeq: 0 },
        }),
      ),
    );

    const sent = JSON.parse(socket.send.mock.calls[0][0]);
    expect(sent.event).toBe("state");
    expect(sent.payload.snapshotSeq).toBe(9);
  });

  it("sends nothing to a client that is fully caught up", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);
    mockStore.getLatestEventSeq.mockReturnValue(4);

    vi.clearAllMocks();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "state-request",
          payload: { afterSeq: 4 },
        }),
      ),
    );

    expect(socket.send).not.toHaveBeenCalled();
  });

  it("logs identity updates as peer-updated and sequences the broadcast", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    const city = { name: "Paris", country: "France", lat: 48.8566, lng: 2.3522, timezone: "Europe/Paris" };
    socket1.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "identity-update",
          payload: { displayName: "Alicia", city },
        }),
      ),
    );

    expect(mockStore.appendEvent).toHaveBeenCalledWith("s1", "peer-updated", expect.any(String));
    const sent = JSON.parse(socket2.send.mock.calls[0][0]);
    expect(sent.event).toBe("peer-updated");
    expect(sent.seq).toBe(1);
    expect(sent.payload).toEqual({ peerId: "p1", displayName: "Alicia", cityJson: JSON.stringify(city) });
  });

  it("should update identity from the authenticated connection and notify the peer", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    vi.clearAllMocks();
    const city = { name: "Paris", country: "France", lat: 48.8566, lng: 2.3522, timezone: "Europe/Paris" };
    socket1.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "identity-update",
          payload: { displayName: "Alicia", city },
        }),
      ),
    );

    expect(mockStore.updatePeerIdentity).toHaveBeenCalledWith("p1", "Alicia", JSON.stringify(city));
    const sent = JSON.parse(socket2.send.mock.calls[0][0]);
    expect(sent.event).toBe("peer-updated");
    expect(sent.payload).toEqual({
      peerId: "p1",
      displayName: "Alicia",
      cityJson: JSON.stringify(city),
    });
  });

  it("should reject an identity update with an empty name", () => {
    const socket = new MockSocket();
    hub.addConnection("s1", "p1", socket as unknown as WebSocket);

    vi.clearAllMocks();
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          version: 1,
          sessionId: "s1",
          peerId: "p1",
          seq: 0,
          timestamp: 123,
          event: "identity-update",
          payload: { displayName: "", city: {} },
        }),
      ),
    );

    expect(mockStore.updatePeerIdentity).not.toHaveBeenCalled();
    const sent = JSON.parse(socket.send.mock.calls[0][0]);
    expect(sent.event).toBe("error");
  });

  it("should tell a new connection which peers are already online", () => {
    const socket1 = new MockSocket();
    const socket2 = new MockSocket();
    hub.addConnection("s1", "p1", socket1 as unknown as WebSocket);

    vi.clearAllMocks();
    hub.addConnection("s1", "p2", socket2 as unknown as WebSocket);

    // The new connection (p2) is told about the already-online p1.
    const joined = JSON.parse(socket2.send.mock.calls[0][0]);
    expect(joined.event).toBe("peer-joined");
    expect(joined.payload.peerId).toBe("p1");
    expect(joined.payload.displayName).toBe("Alice");
  });

  it("should not announce peer-left while another connection of the same peer is live", () => {
    mockStore.getPeer.mockImplementation((id: string) => ({
      id,
      session_id: "s1",
      role: id === "p1" ? "a" : "b",
      display_name: id === "p1" ? "Alice" : "Bob",
      city_json: "{}",
    }));
    const socketA = new MockSocket();
    const socketB = new MockSocket();
    const socketC = new MockSocket();
    hub.addConnection("s1", "p1", socketA as unknown as WebSocket);
    hub.addConnection("s1", "p1", socketB as unknown as WebSocket);
    hub.addConnection("s1", "p2", socketC as unknown as WebSocket);

    // Closing one of p1's two connections must not look like p1 left.
    vi.clearAllMocks();
    socketB.emit("close");
    expect(socketC.send).not.toHaveBeenCalled();

    // Closing the last p1 connection announces peer-left.
    vi.clearAllMocks();
    socketA.emit("close");
    expect(socketC.send).toHaveBeenCalled();
    const sent = JSON.parse(socketC.send.mock.calls[0][0]);
    expect(sent.event).toBe("peer-left");
    expect(sent.payload).toEqual({ peerId: "p1" });
  });
});
