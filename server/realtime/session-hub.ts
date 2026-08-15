import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  CINEMA_EVENT,
  KNOWN_CLIENT_EVENTS,
  makeEnvelope,
  parseClientEnvelope,
  parseEnvelope,
  parseServerEnvelope,
  type ChatSendPayload,
  type StrokePayload,
} from "../../shared/protocol.js";

export interface SessionPeer {
  connectionId: string;
  socket: WebSocket;
  sessionId: string;
  peerId: string;
}

export class SessionHub {
  private peers = new Map<string, SessionPeer>();
  private sessionConnections = new Map<string, Set<string>>();
  private fastify: FastifyInstance;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
  }

  addConnection(sessionId: string, peerId: string, socket: WebSocket) {
    const peer = this.fastify.store.getPeer(peerId);
    if (!peer || peer.session_id !== sessionId) return;

    const connectionId = randomUUID();
    const record: SessionPeer = { connectionId, socket, sessionId, peerId };
    this.peers.set(connectionId, record);

    if (!this.sessionConnections.has(sessionId)) {
      this.sessionConnections.set(sessionId, new Set());
    }
    this.sessionConnections.get(sessionId)!.add(connectionId);

    this.fastify.store.updatePeerLastSeen(peerId);

    socket.on("message", (raw) => {
      this.handleMessage(connectionId, raw);
    });

    socket.on("close", () => {
      this.handleDisconnect(connectionId);
    });

    this.fastify.log.info({ connectionId, sessionId, peerId }, "peer connected");

    const otherConnections = this.getOtherConnections(sessionId, connectionId);
    for (const otherId of otherConnections) {
      // A connection of the same identity (e.g. two tabs, or an overlapping
      // reload) must not make the other see itself as a peer.
      const other = this.peers.get(otherId);
      if (!other || other.peerId === peerId) continue;
      this.sendToConnection(otherId, {
        event: "peer-joined",
        payload: {
          peerId,
          displayName: peer.display_name,
          cityJson: peer.city_json,
        },
      });
    }

    // Live presence is socket truth, not database membership: tell the new
    // connection who is already online right now (deduped by peerId).
    const notified = new Set<string>([peerId]);
    for (const otherId of otherConnections) {
      const other = this.peers.get(otherId);
      if (!other || notified.has(other.peerId)) continue;
      notified.add(other.peerId);
      const otherPeer = this.fastify.store.getPeer(other.peerId);
      this.sendToConnection(connectionId, {
        event: "peer-joined",
        payload: {
          peerId: other.peerId,
          displayName: otherPeer?.display_name,
          cityJson: otherPeer?.city_json,
        },
      });
    }

    return connectionId;
  }

  private handleMessage(connectionId: string, raw: unknown) {
    const record = this.peers.get(connectionId);
    if (!record) return;

    this.fastify.store.updatePeerLastSeen(record.peerId);

    const text = (raw as { toString(): string }).toString();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.sendToConnection(connectionId, {
        event: "error",
        payload: { message: "malformed JSON" },
      });
      return;
    }

    // The client→server union validates the event name AND its payload. A
    // frame that does not match is rejected before any handling runs, so
    // malformed payloads can never crash or corrupt session state.
    const envelope = parseClientEnvelope(parsed);
    if (!envelope) {
      // Distinguish an unknown event (forward compatibility) from a known
      // event carrying a malformed payload so clients get a useful error.
      const base = parseEnvelope(parsed);
      if (base) {
        const message = KNOWN_CLIENT_EVENTS.has(base.event)
          ? `invalid ${base.event} payload`
          : `unsupported event: ${base.event}`;
        this.sendToConnection(connectionId, { event: "error", payload: { message } });
      } else {
        this.sendToConnection(connectionId, {
          event: "error",
          payload: { message: "invalid envelope" },
        });
      }
      return;
    }

    switch (envelope.event) {
      case "hello":
        // The `connected` frame sent on socket establishment is the handshake
        // acknowledgment; hello needs no reply.
        break;
      case "chat":
        this.handleChat(connectionId, record, envelope.payload);
        break;
      case "ping":
        // Echo the client's timestamp verbatim so it can compute RTT.
        this.sendToConnection(connectionId, {
          event: "pong",
          payload: { ts: envelope.payload.ts },
        });
        break;
      case "state-request":
        this.handleStateRequest(connectionId, record, envelope.payload.afterSeq);
        break;
      case "canvas-stroke": {
        const seq = this.logEvent(record.sessionId, "canvas-stroke", envelope.payload);
        if (seq === null) break;
        this.persistStroke(record.sessionId, envelope.payload);
        this.broadcastToSession(
          record.sessionId,
          { event: "canvas-stroke", payload: envelope.payload, seq },
          connectionId,
        );
        break;
      }
      case "canvas-clear": {
        const seq = this.logEvent(record.sessionId, "canvas-clear", {});
        if (seq === null) break;
        this.fastify.store.updateCanvasSnapshot(record.sessionId, "[]");
        this.broadcastToSession(
          record.sessionId,
          { event: "canvas-clear", payload: {}, seq },
          connectionId,
        );
        break;
      }
      case CINEMA_EVENT: {
        const seq = this.logEvent(record.sessionId, CINEMA_EVENT, envelope.payload);
        if (seq === null) break;
        // Persist the current play/pause so a fresh joiner (afterSeq 0, who
        // never replays the event) inherits it from the state snapshot.
        this.fastify.store.upsertCinemaState(record.sessionId, envelope.payload.playing);
        this.broadcastToSession(
          record.sessionId,
          { event: CINEMA_EVENT, payload: envelope.payload, seq },
          connectionId,
        );
        break;
      }
      case "timer": {
        const seq = this.logEvent(record.sessionId, "timer", envelope.payload);
        if (seq === null) break;
        this.fastify.store.upsertTimerState(
          record.sessionId,
          envelope.payload.action,
          envelope.payload.endAt,
          envelope.payload.remaining,
        );
        this.broadcastToSession(
          record.sessionId,
          { event: "timer", payload: envelope.payload, seq },
          connectionId,
        );
        break;
      }
      case "identity-update": {
        const { displayName, city } = envelope.payload;
        const cityJson = JSON.stringify(city);
        const peerUpdated = { peerId: record.peerId, displayName, cityJson };
        // The peerId comes from the authenticated connection, never the
        // payload, so a client can only ever update its own identity.
        const seq = this.logEvent(record.sessionId, "peer-updated", peerUpdated);
        if (seq === null) break;
        this.fastify.store.updatePeerIdentity(record.peerId, displayName, cityJson);
        for (const otherId of this.getOtherConnections(record.sessionId, connectionId)) {
          this.sendToConnection(otherId, { event: "peer-updated", payload: peerUpdated, seq });
        }
        break;
      }
    }
  }

  /**
   * Persist a server→client event to the session event log, allocating the
   * next per-session seq atomically. The payload is validated as a complete
   * server envelope BEFORE persistence, so the event log can never become a
   * bypass around protocol validation. Returns the allocated seq (null if the
   * payload is not a valid server envelope — a server bug, not something to
   * persist or broadcast).
   */
  private logEvent(
    sessionId: string,
    event: string,
    payload: unknown,
  ): number | null {
    const frame = makeEnvelope({ event, sessionId, payload });
    if (!parseServerEnvelope(frame)) {
      this.fastify.log.error(
        { event, sessionId },
        "refusing to log an event that fails the server envelope schema",
      );
      return null;
    }
    return this.fastify.store.appendEvent(sessionId, event, JSON.stringify(payload));
  }

  private persistStroke(sessionId: string, stroke: StrokePayload) {
    const snapshot = this.fastify.store.getCanvasSnapshot(sessionId);
    let strokes: unknown[] = [];
    if (snapshot) {
      try {
        const parsed = JSON.parse(snapshot.strokes_json) as unknown;
        if (Array.isArray(parsed)) strokes = parsed;
      } catch {
        strokes = [];
      }
    }
    strokes.push(stroke);
    this.fastify.store.updateCanvasSnapshot(sessionId, JSON.stringify(strokes));
  }

  private handleChat(
    connectionId: string,
    record: SessionPeer,
    payload: ChatSendPayload,
  ) {
    const peer = this.fastify.store.getPeer(record.peerId);
    if (!peer) return;

    const seq = this.fastify.store.getNextSequence(record.sessionId);
    const messageId = randomUUID();
    const broadcastPayload = {
      id: messageId,
      peerId: record.peerId,
      sender: peer.display_name,
      text: payload.text,
      seq,
      timestamp: Date.now(),
    };

    // The chat broadcast (not the client's send payload) is what enters the
    // durable event stream, so a reconnecting peer replays a server-shaped
    // frame that the client schema already accepts.
    const eventSeq = this.logEvent(record.sessionId, "chat", broadcastPayload);
    if (eventSeq === null) return;

    this.fastify.store.addMessage(
      messageId,
      record.sessionId,
      record.peerId,
      peer.display_name,
      payload.text,
      seq,
    );

    // Echo both the client's ref id (so the sender can correlate the ack with
    // its local message) and the server-assigned message id (so the sender can
    // dedupe against history after a reconnect).
    this.sendToConnection(connectionId, {
      event: "ack",
      payload: {
        refSeq: seq,
        refId: payload.id,
        id: messageId,
      },
    });

    this.broadcastToSession(
      record.sessionId,
      { event: "chat", payload: broadcastPayload, seq: eventSeq },
      connectionId,
    );
  }

  private handleStateRequest(connectionId: string, record: SessionPeer, afterSeq: number) {
    const latest = this.fastify.store.getLatestEventSeq(record.sessionId);

    // Replay is for clients that already have base state (afterSeq > 0) whose
    // requested range is still contiguous. A fresh client (afterSeq 0) always
    // gets the snapshot: the log contains events, not the peer/session base a
    // new page needs. A client fully caught up (afterSeq >= latest) needs
    // nothing.
    if (afterSeq > 0) {
      if (afterSeq >= latest) return; // fully caught up — nothing to send
      const events = this.fastify.store.getEventsAfterSeq(record.sessionId, afterSeq);
      if (events.length > 0 && events[0].seq === afterSeq + 1) {
        let replayed = true;
        for (const ev of events) {
          let payload: unknown;
          try {
            payload = JSON.parse(ev.payload_json);
          } catch {
            this.fastify.log.error(
              { sessionId: record.sessionId, seq: ev.seq },
              "event log row has an unparsable payload; falling back to snapshot",
            );
            replayed = false;
            break;
          }
          // Replay preserves each event's original seq and timestamp.
          this.sendToConnection(connectionId, {
            event: ev.event,
            payload,
            seq: ev.seq,
            timestamp: ev.created_at,
          });
        }
        if (replayed) return;
      }
      // Pruned / non-contiguous range → authoritative snapshot below.
    }

    const state = this.fastify.store.getSessionState(record.sessionId);
    if (!state) return;

    this.sendToConnection(connectionId, {
      event: "state",
      payload: {
        session: state.session,
        peers: state.peers,
        messages: state.messages,
        canvas: state.canvas,
        timer: state.timer,
        cinema: state.cinema,
        snapshotSeq: latest,
      },
    });
  }

  private handleDisconnect(connectionId: string) {
    const record = this.peers.get(connectionId);
    if (!record) return;

    this.peers.delete(connectionId);
    const sessionConns = this.sessionConnections.get(record.sessionId);
    if (sessionConns) {
      sessionConns.delete(connectionId);
      if (sessionConns.size === 0) {
        this.sessionConnections.delete(record.sessionId);
      }
    }

    const remainingConnections = this.getOtherConnections(
      record.sessionId,
      connectionId,
    );

    // A peer is online while ANY of its connections is live (e.g. two tabs or
    // an overlapping reload): only announce peer-left when the last connection
    // for that peerId closes, so live peers never see a spurious departure.
    const stillOnline = remainingConnections.some(
      (cid) => this.peers.get(cid)?.peerId === record.peerId,
    );
    if (stillOnline) {
      this.fastify.log.info(
        { connectionId, sessionId: record.sessionId, peerId: record.peerId },
        "peer connection closed (another remains)",
      );
      return;
    }

    for (const otherId of remainingConnections) {
      this.sendToConnection(otherId, {
        event: "peer-left",
        payload: { peerId: record.peerId },
      });
    }

    this.fastify.log.info(
      { connectionId, sessionId: record.sessionId, peerId: record.peerId },
      "peer disconnected",
    );
  }

  sendToConnection(
    connectionId: string,
    data: { event: string; payload: unknown; seq?: number; timestamp?: number },
  ) {
    const record = this.peers.get(connectionId);
    if (!record || record.socket.readyState !== WebSocket.OPEN) return;
    const frame = makeEnvelope({
      event: data.event,
      sessionId: record.sessionId,
      peerId: record.peerId,
      seq: data.seq ?? 0,
      timestamp: data.timestamp ?? Date.now(),
      payload: data.payload,
    });
    // Hard guarantee: every server→client frame is a full, schema-valid
    // envelope. A frame that does not satisfy the server union is a bug in
    // the server, not something to send.
    if (!parseServerEnvelope(frame)) {
      this.fastify.log.error(
        { event: data.event, connectionId, sessionId: record.sessionId },
        "dropping outbound frame that fails the server envelope schema",
      );
      return;
    }
    record.socket.send(JSON.stringify(frame));
  }

  broadcastToSession(
    sessionId: string,
    data: { event: string; payload: unknown; seq?: number },
    excludeConnectionId?: string,
  ) {
    const sessionConns = this.sessionConnections.get(sessionId);
    if (!sessionConns) return;

    for (const cid of sessionConns) {
      if (cid !== excludeConnectionId) {
        this.sendToConnection(cid, data);
      }
    }
  }

  private getOtherConnections(sessionId: string, excludeId: string): string[] {
    const sessionConns = this.sessionConnections.get(sessionId);
    if (!sessionConns) return [];
    const result: string[] = [];
    for (const cid of sessionConns) {
      if (cid !== excludeId) result.push(cid);
    }
    return result;
  }

  /**
   * Live presence is socket truth: a peerId is online when any of its
   * connections has a live socket. Database membership alone (a persisted
   * peer row) never counts as online.
   */
  isPeerOnline(peerId: string): boolean {
    for (const record of this.peers.values()) {
      if (record.peerId === peerId) return true;
    }
    return false;
  }

  /**
   * Close every live socket for a peerId (used when its seat is reclaimed by a
   * new joiner, or on an explicit leave). Runs the same bookkeeping and
   * peer-left announcements as a natural disconnect.
   */
  kickPeer(peerId: string): void {
    for (const [connectionId, record] of [...this.peers]) {
      if (record.peerId !== peerId) continue;
      record.socket.close(1000, "seat reclaimed");
      this.handleDisconnect(connectionId);
    }
  }

  get activeConnections(): number {
    return this.peers.size;
  }
}
