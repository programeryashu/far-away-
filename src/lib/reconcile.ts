import { isValidCityData, type CityData } from './cities';
import type { TimerPayload } from './broadcast';

// Server-side shapes returned inside the `state` envelope / GET state payload.
// shared/protocol.ts is the single source of truth for these shapes — the
// schemas mirror the rows in server/db/schema.ts, so nothing here may drift
// from what the server actually produces.
import type {
  StateCanvas as ServerCanvas,
  StateMessage as ServerMessage,
  StatePayload as ServerStatePayload,
  StatePeer as ServerPeer,
  StateTimer as ServerTimer,
} from '../../shared/protocol';

export type {
  ServerCanvas,
  ServerMessage,
  ServerPeer,
  ServerStatePayload,
  ServerTimer,
};

export interface ClientMessage {
  id: string;
  /** Server-assigned id, once the ack for a locally-sent message arrives. */
  serverId?: string;
  sender: string;
  text: string;
  timestamp: string;
  status: 'sending' | 'routing' | 'delivered';
}

/**
 * Merge incoming messages into an existing list, deduping so a repeated
 * `state` envelope or a live broadcast that also appears in history never
 * duplicates a message. Dedupes by id, and also skips history rows whose id
 * matches the server id already adopted by a locally-sent message.
 */
export function mergeMessages(
  existing: ClientMessage[],
  incoming: ClientMessage[],
): ClientMessage[] {
  const seen = new Set(existing.map((m) => m.id));
  const seenServerIds = new Set(
    existing.filter((m) => m.serverId).map((m) => m.serverId as string)
  );
  const merged = [...existing];
  for (const msg of incoming) {
    if (seen.has(msg.id) || seenServerIds.has(msg.id)) continue;
    seen.add(msg.id);
    merged.push(msg);
  }
  return merged;
}

export function serverMessagesToClient(messages: ServerMessage[]): ClientMessage[] {
  return messages.map((m) => ({
    id: m.id,
    sender: m.sender_name || 'Peer',
    text: m.text,
    timestamp: new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    status: 'delivered' as const,
  }));
}

/** Peers other than `myPeerId` — the people who are not this client. */
export function otherPeers(peers: ServerPeer[], myPeerId: string): ServerPeer[] {
  return peers.filter((p) => p.id !== myPeerId);
}

export interface PeerIdentity {
  name: string;
  city: CityData | null;
}

/** Build an identity from raw parts (used by the peer-joined payload). */
export function identityFromParts(
  displayName: string,
  cityJson: string,
): PeerIdentity | null {
  let city: CityData | null = null;
  if (cityJson) {
    try {
      const parsed: unknown = JSON.parse(cityJson);
      if (isValidCityData(parsed)) city = parsed;
    } catch {
      city = null;
    }
  }
  if (!displayName && !city) return null;
  return { name: displayName || 'Peer', city };
}

/** Extract a usable identity from a server peer row (defensive about city_json). */
export function peerIdentity(peer: ServerPeer): PeerIdentity | null {
  return identityFromParts(peer.display_name, peer.city_json);
}

/** Parse a persisted canvas snapshot into an array of strokes (defensive). */
export function parseCanvasStrokes(canvas: ServerCanvas | null): unknown[] {
  if (!canvas) return [];
  try {
    const parsed: unknown = JSON.parse(canvas.strokes_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Convert the persisted timer row into the live timer payload a client applies. */
export function parseTimerState(timer: ServerTimer | null): TimerPayload | null {
  if (!timer) return null;
  return {
    action: timer.action,
    endAt: timer.end_at,
    remaining: timer.remaining,
  };
}
