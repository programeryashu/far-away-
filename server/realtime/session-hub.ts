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
        this.handleStateRequest(connectionId, record);
        break;
      case "canvas-stroke":
        this.persistStroke(record.sessionId, envelope.payload);
        this.broadcastToSession(
          record.sessionId,
          { event: "canvas-stroke", payload: envelope.payload },
          connectionId,
        );
        break;
      case "canvas-clear":
        this.fastify.store.updateCanvasSnapshot(record.sessionId, "[]");
        this.broadcastToSession(
          record.sessionId,
          { event: "canvas-clear", payload: {} },
          connectionId,
        );
        break;
      case CINEMA_EVENT:
        this.broadcastToSession(
          record.sessionId,
          { event: CINEMA_EVENT, payload: envelope.payload },
          connectionId,
        );
        break;
      case "timer":
        this.fastify.store.upsertTimerState(
          record.sessionId,
          envelope.payload.action,
          envelope.payload.endAt,
          envelope.payload.remaining,
        );
        this.broadcastToSession(
          record.sessionId,
          { event: "timer", payload: envelope.payload },
          connectionId,
        );
        break;
      case "identity-update": {
        const { displayName, city } = envelope.payload;
        // The peerId comes from the authenticated connection, never the
        // payload, so a client can only ever update its own identity.
        this.fastify.store.updatePeerIdentity(
          record.peerId,
          displayName,
          JSON.stringify(city),
        );
        for (const otherId of this.getOtherConnections(record.sessionId, connectionId)) {
          this.sendToConnection(otherId, {
            event: "peer-updated",
            payload: {
              peerId: record.peerId,
              displayName,
              cityJson: JSON.stringify(city),
            },
          });
        }
        break;
      }
    }
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
      {
        event: "chat",
        payload: {
          id: messageId,
          peerId: record.peerId,
          sender: peer.display_name,
          text: payload.text,
          seq,
          timestamp: Date.now(),
        },
      },
      connectionId,
    );
  }

  private handleStateRequest(connectionId: string, record: SessionPeer) {
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
    data: { event: string; payload: unknown },
  ) {
    const record = this.peers.get(connectionId);
    if (!record || record.socket.readyState !== WebSocket.OPEN) return;
    const frame = makeEnvelope({
      event: data.event,
      sessionId: record.sessionId,
      peerId: record.peerId,
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
    data: { event: string; payload: unknown },
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

  get activeConnections(): number {
    return this.peers.size;
  }
}
