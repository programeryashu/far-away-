// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, act } from '@testing-library/react';
import { ActivityFinder } from './ActivityFinder';
import { makeEnvelope, type ServerEnvelope } from '../../shared/protocol';
import type { Connection } from '../lib/connection';

Element.prototype.scrollIntoView = () => {};

/**
 * A scripted Connection: components must not care which transport is active,
 * so the fake records sends and lets the test emit inbound envelopes exactly
 * the way LocalConnection/RemoteConnection deliver them. Emits are wrapped in
 * act() so the component's setState flushes before assertions.
 */
function createFakeConnection(role: 'a' | 'b' = 'a') {
  let eventListener: ((env: ServerEnvelope) => void) | null = null;
  const send = vi.fn();
  const conn: Connection = {
    mode: 'remote',
    role,
    start: () => {},
    stop: () => {},
    send,
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
    send,
    emit: (env: ServerEnvelope) => act(() => eventListener?.(env)),
  };
}

const timerEnv = (payload: { action: 'start' | 'pause' | 'reset'; endAt: number; remaining: number }) =>
  makeEnvelope({ event: 'timer', payload }) as ServerEnvelope;

describe('ActivityFinder', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // jsdom has no 2d canvas context; a minimal stub lets the draw path run.
    HTMLCanvasElement.prototype.getContext = (() => ({
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      clearRect: () => {},
      setTransform: () => {},
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderFinder = (role: 'a' | 'b' = 'a') => {
    const fake = createFakeConnection(role);
    render(<ActivityFinder nameA="Alice" nameB="Bob" connection={fake.conn} hasPeer={false} />);
    return fake;
  };

  it('sends exactly one timer action per click and reflects inbound state', () => {
    const { conn, emit } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Deep Space Coffee' })); // Deep Space Coffee

    const startBtn = screen.getByRole('button', { name: /start/i });
    fireEvent.click(startBtn);
    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith(
      'timer',
      expect.objectContaining({ action: 'start', remaining: 0 }),
    );
    expect((startBtn as HTMLButtonElement).disabled).toBe(true);

    // A second click while running must not produce a duplicate event.
    fireEvent.click(startBtn);
    expect(conn.send).toHaveBeenCalledTimes(1);

    // An inbound peer pause applies: the countdown shows the peer's remaining
    // time and Start becomes available again.
    emit(timerEnv({ action: 'pause', endAt: 0, remaining: 300 }));
    expect(screen.getByText('05:00')).toBeTruthy();
    expect((startBtn as HTMLButtonElement).disabled).toBe(false);

    // Restart from the peer's position, then pause and reset — one send each.
    fireEvent.click(startBtn);
    expect(conn.send).toHaveBeenCalledTimes(2);
    expect(conn.send).toHaveBeenLastCalledWith('timer', expect.objectContaining({ action: 'start' }));

    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(conn.send).toHaveBeenCalledTimes(3);
    expect(conn.send).toHaveBeenLastCalledWith('timer', expect.objectContaining({ action: 'pause' }));

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(conn.send).toHaveBeenCalledTimes(4);
    expect(conn.send).toHaveBeenLastCalledWith(
      'timer',
      expect.objectContaining({ action: 'reset', remaining: 1500 }),
    );
  });

  it('a fresh joiner inherits an already-running cinema from the state snapshot', () => {
    const { emit } = renderFinder();
    // The authoritative snapshot (an afterSeq 0 join) carries the persisted
    // cinema row — the cinema event itself is never replayed to such a client.
    emit(
      makeEnvelope({
        event: 'state',
        payload: {
          cinema: { session_id: 's1', playing: true, position: 30, updated_at: Date.now() - 5000 },
        },
      }) as unknown as ServerEnvelope,
    );
    // Opening SynchroCinema shows the shared watch already playing, and the
    // video resumes from the wall-clock-advanced position once metadata loads.
    fireEvent.click(screen.getByRole('button', { name: 'Open SynchroCinema' })); // SynchroCinema
    expect(screen.getByRole('button', { name: 'Pause playback' })).toBeTruthy();
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video).toBeTruthy();
    fireEvent(video, new Event('loadedmetadata'));
    expect(video.currentTime).toBeGreaterThanOrEqual(35);
    expect(video.currentTime).toBeLessThanOrEqual(35.5);
  });

  it('sends a cinema toggle exactly once per click and mirrors the peer', () => {
    const { conn, emit } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open SynchroCinema' })); // SynchroCinema

    const modal = screen.getByText('SynchroCinema').closest('.glass-panel') as HTMLElement;
    const play = modal.querySelector('button.btn-primary') as HTMLButtonElement;

    fireEvent.click(play);
    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith('cinema', { playing: true, position: 0 });

    // Peer paused at a different position → the play state mirrors the peer
    // and the local video seeks to the peer's position.
    emit(
      makeEnvelope({ event: 'cinema', payload: { playing: false, position: 20 } }) as ServerEnvelope,
    );
    expect(screen.getByText(/Bob pressed PAUSE at 00:20/)).toBeTruthy();
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video.currentTime).toBe(20);

    fireEvent.click(play);
    expect(conn.send).toHaveBeenCalledTimes(2);
    expect(conn.send).toHaveBeenCalledWith('cinema', { playing: true, position: 20 });
  });

  it('seeks propagate to the peer and re-anchor local playback', () => {
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open SynchroCinema' })); // SynchroCinema

    const seek = screen.getByLabelText('Seek video') as HTMLInputElement;
    // Range inputs fire native `input` events on drag (React binds onChange to it).
    fireEvent.input(seek, { target: { value: '15' } });
    expect(conn.send).toHaveBeenCalledWith('cinema', { playing: false, position: 15 });
    expect(document.querySelector('video')!.currentTime).toBe(15);
  });

  it('sends completed canvas strokes via pointer events (mouse and touch) and clears exactly once', () => {
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Galactic Canvas' })); // Galactic Canvas

    const canvas = document.querySelector('canvas') as HTMLCanvasElement;

    // Mouse pointer.
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerMove(canvas, { clientX: 15, clientY: 12, pointerId: 1, pointerType: 'mouse' });
    fireEvent.pointerUp(canvas, { clientX: 20, clientY: 20, pointerId: 1, pointerType: 'mouse' });
    expect(conn.send).toHaveBeenCalledWith(
      'canvas-stroke',
      expect.objectContaining({
        points: [
          { x: 10, y: 10 },
          { x: 15, y: 12 },
          { x: 20, y: 20 },
        ],
        color: expect.any(String),
      }),
    );

    // Touch pointer — the phone path.
    fireEvent.pointerDown(canvas, { clientX: 30, clientY: 30, pointerId: 2, pointerType: 'touch' });
    fireEvent.pointerUp(canvas, { clientX: 40, clientY: 40, pointerId: 2, pointerType: 'touch' });
    expect(conn.send).toHaveBeenCalledTimes(2);

    // A cancelled stroke still finalizes (pointercancel = e.g. incoming call).
    fireEvent.pointerDown(canvas, { clientX: 50, clientY: 50, pointerId: 3, pointerType: 'touch' });
    fireEvent.pointerCancel(canvas, { pointerId: 3, pointerType: 'touch' });
    expect(conn.send).toHaveBeenCalledTimes(3);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(conn.send).toHaveBeenCalledWith('canvas-clear', {});
  });

  it('starts the shared timer from a Start Together launch exactly once', () => {
    const fake = createFakeConnection('a');
    const { rerender } = render(
      <ActivityFinder
        nameA="Alice"
        nameB="Bob"
        connection={fake.conn}
        hasPeer={false}
        launchRequest={{ type: 'timer', durationMin: 30, nonce: 1 }}
      />,
    );

    // The activity opens and the canonical timer action fires exactly once.
    expect(screen.getByText('Deep Space Coffee')).toBeTruthy();
    expect(fake.conn.send).toHaveBeenCalledTimes(1);
    expect(fake.conn.send).toHaveBeenCalledWith(
      'timer',
      expect.objectContaining({ action: 'start', remaining: 0 }),
    );
    const endAt = (fake.send.mock.calls[0][1] as { endAt: number }).endAt;
    expect(Math.abs(endAt - (Date.now() + 30 * 60_000))).toBeLessThan(5000);

    // Re-rendering the same nonce must not re-apply (exactly-once consumption).
    rerender(
      <ActivityFinder
        nameA="Alice"
        nameB="Bob"
        connection={fake.conn}
        hasPeer={false}
        launchRequest={{ type: 'timer', durationMin: 30, nonce: 1 }}
      />,
    );
    expect(fake.conn.send).toHaveBeenCalledTimes(1);
  });

  it('forces cinema play from a Start Together launch exactly once', () => {
    const fake = createFakeConnection('a');
    render(
      <ActivityFinder
        nameA="Alice"
        nameB="Bob"
        connection={fake.conn}
        hasPeer={false}
        launchRequest={{ type: 'cinema', nonce: 7 }}
      />,
    );
    expect(screen.getByText('SynchroCinema')).toBeTruthy();
    expect(fake.conn.send).toHaveBeenCalledTimes(1);
    expect(fake.conn.send).toHaveBeenCalledWith('cinema', { playing: true, position: 0 });
  });

  it('opens the canvas from a Start Together launch without inventing events', () => {
    const fake = createFakeConnection('a');
    render(
      <ActivityFinder
        nameA="Alice"
        nameB="Bob"
        connection={fake.conn}
        hasPeer={false}
        launchRequest={{ type: 'canvas', nonce: 3 }}
      />,
    );
    expect(screen.getByText('Galactic Canvas')).toBeTruthy();
    expect(fake.conn.send).not.toHaveBeenCalled();
  });
});
