import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { parseEnvelope } from "../../shared/protocol.js";

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
      this.sendToConnection(otherId, {
        event: "peer-joined",
        payload: { peerId },
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

    const envelope = parseEnvelope(parsed);
    if (!envelope) {
      this.sendToConnection(connectionId, {
        event: "error",
        payload: { message: "invalid envelope" },
      });
      return;
    }

    switch (envelope.event) {
      case "chat":
        this.handleChat(connectionId, record, envelope.payload);
        break;
      case "ping":
        this.sendToConnection(connectionId, { event: "pong", payload: {} });
        break;
      case "state-request":
        this.handleStateRequest(connectionId, record);
        break;
      case "canvas-stroke":
      case "canvas-clear":
      case "timer":
        this.broadcastToSession(
          record.sessionId,
          { event: envelope.event, payload: envelope.payload },
          connectionId,
        );
        break;
      default:
        this.sendToConnection(connectionId, {
          event: "error",
          payload: { message: `unsupported event: ${envelope.event}` },
        });
        break;
    }
  }

  // Removed handleHello as client-triggered

  private handleChat(
    connectionId: string,
    record: SessionPeer,
    payload: unknown,
  ) {
    const chatPayload = payload as { text?: string };
    if (
      !chatPayload ||
      typeof chatPayload !== "object" ||
      typeof chatPayload.text !== "string" ||
      !chatPayload.text.trim()
    ) {
      this.sendToConnection(connectionId, {
        event: "error",
        payload: { message: "invalid chat payload" },
      });
      return;
    }

    const peer = this.fastify.store.getPeer(record.peerId);
    if (!peer) return;

    const seq = this.fastify.store.getNextSequence(record.sessionId);
    const messageId = randomUUID();

    this.fastify.store.addMessage(
      messageId,
      record.sessionId,
      record.peerId,
      peer.display_name,
      chatPayload.text,
      seq,
    );

    this.sendToConnection(connectionId, {
      event: "ack",
      payload: { refSeq: seq },
    });

    this.broadcastToSession(
      record.sessionId,
      {
        event: "chat",
        payload: {
          peerId: record.peerId,
          text: chatPayload.text,
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
    record.socket.send(JSON.stringify(data));
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
