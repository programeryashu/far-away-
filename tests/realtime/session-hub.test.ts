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
  const mockFastify = { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } } as never;
  const mockStore = {
    getPeer: vi.fn(),
    updatePeerLastSeen: vi.fn(),
    getNextSequence: vi.fn().mockReturnValue(1),
    addMessage: vi.fn(),
    upsertTimerState: vi.fn(),
    updatePeerIdentity: vi.fn(),
  };
  Object.assign(mockFastify, { store: mockStore });

  beforeEach(() => {
    uuidCounter = 0;
    vi.clearAllMocks();
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
