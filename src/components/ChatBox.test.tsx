// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { ChatBox } from './ChatBox';
import { makeEnvelope, type ServerEnvelope } from '../../shared/protocol';
import type { Connection } from '../lib/connection';

Element.prototype.scrollIntoView = () => {};

function createFakeConnection(role: 'a' | 'b' = 'a') {
  let eventListener: ((env: ServerEnvelope) => void) | null = null;
  const conn: Connection = {
    mode: 'remote',
    role,
    start: () => {},
    stop: () => {},
    send: vi.fn(),
    onEvent: (fn) => {
      eventListener = fn;
      return () => {
        eventListener = null;
      };
    },
    onStatus: () => () => {},
    onPeerChange: () => () => {},
    onSeqChange: () => () => {},
  };
  return {
    conn,
    emit: (env: ServerEnvelope) => act(() => eventListener?.(env)),
  };
}

const cityA = { name: 'San Francisco', lat: 37.77, lng: -122.42, timezone: 'America/Los_Angeles' };
const cityB = { name: 'Tokyo', lat: 35.68, lng: 139.69, timezone: 'Asia/Tokyo' };

const chatEnv = (id: string, peerId: string, text: string) =>
  makeEnvelope({
    event: 'chat',
    payload: { id, peerId, sender: 'Alex', text, seq: 1, timestamp: Date.now() },
  }) as unknown as ServerEnvelope;

const ackEnv = (refId: string, id: string) =>
  makeEnvelope({ event: 'ack', payload: { refSeq: 1, refId, id } }) as unknown as ServerEnvelope;

/** The alignment class of a message — 'own' means right-aligned. */
const alignmentOf = (text: string) => {
  const bubble = screen.getByText(text).closest('div');
  return (bubble!.parentElement as HTMLElement).className.includes('own') ? 'own' : 'peer';
};

describe('ChatBox message ownership', () => {
  let fake: ReturnType<typeof createFakeConnection>;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const renderBox = (myPeerId: string) => {
    fake = createFakeConnection('a');
    render(
      <ChatBox
        cityA={cityA}
        cityB={cityB}
        nameA="Alex"
        nameB="Alex" // both peers share a display name
        connection={fake.conn}
        hasPeer
        myPeerId={myPeerId}
      />,
    );
  };

  it('aligns by peerId, not display name: same-name peers each see own vs peer messages', () => {
    renderBox('p1');

    // Both messages are from "Alex" — ownership is decided by peerId.
    fake.emit(chatEnv('m-own', 'p1', 'mine mine'));
    fake.emit(chatEnv('m-peer', 'p2', 'theirs theirs'));

    // The bubble container aligns own messages right, the peer's left.
    expect(alignmentOf('mine mine')).toBe('own');
    expect(alignmentOf('theirs theirs')).toBe('peer');
  });

  it('marks locally sent messages as own even before the server ids them', () => {
    renderBox('p1');

    const input = screen.getByLabelText(/Message Alex/);
    fireEvent.change(input, { target: { value: 'hello world' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    expect(alignmentOf('hello world')).toBe('own');
  });

  it('treats an echo of its own server message as own across a reconnect replay', () => {
    renderBox('p1');

    const input = screen.getByLabelText(/Message Alex/);
    fireEvent.change(input, { target: { value: 'replayed' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    // The ack swaps the local id for the server id before the replay arrives,
    // so the replayed history row dedupes instead of duplicating.
    const sentCall = (fake.conn.send as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'chat',
    ) as unknown as [string, { id?: string }] | undefined;
    const localId = sentCall?.[1]?.id as string;
    fake.emit(ackEnv(localId, 'm-1'));
    fake.emit(chatEnv('m-1', 'p1', 'replayed'));

    expect(screen.getAllByText('replayed')).toHaveLength(1);
    expect(alignmentOf('replayed')).toBe('own');
  });

  it('history rows from the state snapshot align by sender_peer', () => {
    renderBox('p1');

    fake.emit(
      makeEnvelope({
        event: 'state',
        payload: {
          session: { id: 's1', code: 'C1', status: 'active', created_at: 1, expires_at: 9, closed_at: null },
          peers: [],
          messages: [
            { id: 'h1', session_id: 's1', sender_peer: 'p1', sender_name: 'Alex', text: 'own history', ts: 1, seq: 1 },
            { id: 'h2', session_id: 's1', sender_peer: 'p2', sender_name: 'Alex', text: 'peer history', ts: 2, seq: 2 },
          ],
          canvas: null,
          timer: null,
          cinema: null,
          snapshotSeq: 2,
        },
      }) as unknown as ServerEnvelope,
    );

    expect(alignmentOf('own history')).toBe('own');
    expect(alignmentOf('peer history')).toBe('peer');
  });

  it('labels local solo-mode replies as simulated — never as a real person', async () => {
    // Local solo mode: the offline fallback answers after a delay.
    const localFake = createFakeConnection('a');
    const localConn = { ...localFake.conn, mode: 'local' as const };
    render(
      <ChatBox
        cityA={cityA}
        cityB={cityB}
        nameA="Alex"
        nameB="Alex"
        connection={localConn}
        hasPeer={false}
        myPeerId=""
      />,
    );

    const input = screen.getByLabelText(/Message Alex/);
    fireEvent.change(input, { target: { value: 'anyone there?' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    // The seeded preview message is labeled too.
    expect(screen.getAllByText('simulated').length).toBeGreaterThanOrEqual(1);

    // After the fallback delay, the auto-reply arrives — also labeled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3200);
    });
    const tags = screen.getAllByText('simulated');
    expect(tags.length).toBeGreaterThanOrEqual(2);
  });
});
