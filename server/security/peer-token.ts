import { createHash, randomBytes } from "node:crypto";

/**
 * Session-scoped peer capability tokens.
 *
 * A join response hands the joining client a secret token; the server keeps
 * only its SHA-256 hash. The token authorizes the actions that act AS that
 * peer — the WebSocket upgrade and the leave endpoint — so knowing a peerId
 * is never enough to hijack or kick someone. The token never leaves the
 * joining client: it is not broadcast, not put in the state snapshot, and not
 * returned by any read endpoint.
 */

export function issuePeerToken(): string {
  return randomBytes(24).toString("base64url");
}

export function hashPeerToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** True when a presented token hashes to the stored hash. Empty/absent never matches. */
export function peerTokenMatches(token: string | undefined, tokenHash: string): boolean {
  if (!token || !tokenHash) return false;
  return hashPeerToken(token) === tokenHash;
}
