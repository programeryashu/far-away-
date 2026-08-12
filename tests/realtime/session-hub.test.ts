import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionHub } from "../../server/realtime/session-hub.js";
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

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
  const mockFastify = { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } } as never;
  const mockStore = { getPeer: vi.fn(), updatePeerLastSeen: vi.fn() };
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
    hub.broadcastToSession("s1", { event: "chat", payload: { text: "hi" } }, id1);
    expect(socket1.send).not.toHaveBeenCalled();
    expect(socket2.send).toHaveBeenCalled();
  });
});
