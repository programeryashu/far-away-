import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ApiError,
  createSession,
  joinSession,
  joinSessionByCode,
  leaveSession,
} from "./api";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

const failJson = (status: number, error: string) =>
  ({
    ok: false,
    status,
    json: async () => ({ error }),
  }) as Response;

describe("api", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a session", async () => {
    fetchMock.mockResolvedValue(okJson({ id: "s1", code: "ABC", expiresAt: 123 }));
    const session = await createSession();
    expect(session.id).toBe("s1");
  });

  it("joins a session and returns peerId + role", async () => {
    fetchMock.mockResolvedValue(okJson({ peerId: "p1", role: "b" }));
    const res = await joinSession("s1", "Bob", { name: "Tokyo", country: "Japan", lat: 1, lng: 2, timezone: "Asia/Tokyo" });
    expect(res).toEqual({ peerId: "p1", role: "b" });
    const called = fetchMock.mock.calls[0];
    expect(String(called[0])).toBe("/api/sessions/s1/join");
  });

  it("maps an expired invite (410) to an ApiError with the server message", async () => {
    fetchMock.mockResolvedValue(failJson(410, "Session has expired"));
    await expect(joinSession("s1", "Bob", {} as never)).rejects.toMatchObject({
      name: "ApiError",
      status: 410,
      message: "Session has expired",
    });
  });

  it("joins by human-friendly code and returns the session id", async () => {
    fetchMock.mockResolvedValue(okJson({ sessionId: "s1", peerId: "p1", role: "b" }));
    const res = await joinSessionByCode("ABC123", "Bob", {
      name: "Tokyo",
      country: "Japan",
      lat: 1,
      lng: 2,
      timezone: "Asia/Tokyo",
    });
    expect(res).toEqual({ sessionId: "s1", peerId: "p1", role: "b" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/sessions/join-by-code");
    expect(JSON.parse(String(init.body))).toMatchObject({ code: "ABC123", displayName: "Bob" });
  });

  it("maps an unknown code to a 404 ApiError", async () => {
    fetchMock.mockResolvedValue(failJson(404, "Session not found"));
    await expect(joinSessionByCode("ZZZZZZ", "Bob", {} as never)).rejects.toMatchObject({
      status: 404,
      message: "Session not found",
    });
  });

  it("maps 404 and 409 to typed errors", async () => {
    fetchMock.mockResolvedValue(failJson(404, "Session not found"));
    await expect(joinSession("x", "Bob", {} as never)).rejects.toMatchObject({ status: 404 });

    fetchMock.mockResolvedValue(failJson(409, "Session full"));
    await expect(joinSession("x", "Bob", {} as never)).rejects.toMatchObject({ status: 409 });
  });

  it("maps a network failure to an ApiError with null status", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(createSession()).rejects.toBeInstanceOf(ApiError);
    await expect(createSession()).rejects.toMatchObject({ status: null });
  });

  it("leaves a session", async () => {
    fetchMock.mockResolvedValue(okJson({ ok: true }));
    await expect(leaveSession("s1", "p1")).resolves.toBeUndefined();
  });
});
