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
    // Deliver without act(): lets a test reproduce the socket-timing window
    // where an inbound frame is handled before React commits a pending state
    // update (the caller wraps the whole sequence in act).
    emitRaw: (env: ServerEnvelope) => eventListener?.(env),
  };
}

const timerEnv = (payload: { action: 'start' | 'pause' | 'reset'; endAt: number; remaining: number }) =>
  makeEnvelope({ event: 'timer', payload }) as ServerEnvelope;

// A canned Watch movie + region availability, served by a fetch stub so the
// discovery flow (search → detail → watch together) works without a server.
const SAMPLE_MOVIE = {
  id: 550,
  title: 'Fight Club',
  year: 1999,
  runtime: 139,
  overview: 'An insomniac and a soap salesman build a fight club.',
  poster: null,
  backdrop: null,
};

const stubWatchFetch = () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/watch/search')) {
      // Real TMDB search rows have no runtime — the detail call provides it.
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, query: 'fight', movies: [{ ...SAMPLE_MOVIE, runtime: null }] }),
      } as Response;
    }
    if (url.includes('/availability')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          movieId: 550,
          regions: [
            { region: 'US', country: 'United States', providers: ['Netflix'] },
            { region: 'JP', country: 'Japan', providers: [] },
          ],
        }),
      } as Response;
    }
    if (/\/api\/watch\/\d+$/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, movie: SAMPLE_MOVIE }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
};

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
    render(
      <ActivityFinder
        nameA="Alice"
        nameB="Bob"
        connection={fake.conn}
        hasPeer={false}
        countryA="United States"
        countryB="Japan"
        windowMinutes={45}
      />,
    );
    return fake;
  };

  it('reports activity starts through onActivityStarted (timer, watch, canvas)', async () => {
    stubWatchFetch();
    const onActivityStarted = vi.fn();
    const fake = createFakeConnection('a');
    render(
      <ActivityFinder
        nameA="Alice"
        nameB="Bob"
        connection={fake.conn}
        hasPeer={false}
        onActivityStarted={onActivityStarted}
        countryA="United States"
        countryB="Japan"
        windowMinutes={45}
      />,
    );

    // Timer start reports once.
    fireEvent.click(screen.getByRole('button', { name: 'Open Focus' }));
    fireEvent.click(screen.getByRole('button', { name: /start/i }));
    expect(onActivityStarted).toHaveBeenCalledWith('a shared timer');

    // Watch together reports once (choosing a movie starts the watch); the
    // in-player pause afterwards does not re-invite.
    fireEvent.click(screen.getByRole('button', { name: 'Close Focus' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    // Discovery first — never straight into playback.
    expect(screen.getByText('What do we want to watch?')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search movies'), { target: { value: 'fight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const result = await screen.findByRole('button', { name: /Open Fight Club/ });
    fireEvent.click(result);
    fireEvent.click(screen.getByRole('button', { name: 'Watch together' }));
    expect(onActivityStarted).toHaveBeenCalledWith('a shared watch');
    fireEvent.click(screen.getByRole('button', { name: /pause playback/i }));
    expect(onActivityStarted).toHaveBeenCalledTimes(2);

    // First canvas stroke reports once.
    fireEvent.click(screen.getByRole('button', { name: 'Close Watch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Canvas' }));
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    fireEvent.pointerDown(canvas, { clientX: 5, clientY: 5, pointerId: 1, pointerType: 'touch' });
    fireEvent.pointerUp(canvas, { clientX: 10, clientY: 10, pointerId: 1, pointerType: 'touch' });
    expect(onActivityStarted).toHaveBeenCalledWith('Canvas');
  });

  it('sends exactly one timer action per click and reflects inbound state', () => {
    const { conn, emit } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Focus' }));

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

  it('a fresh joiner inherits an already-running cinema (movie + playback) from the state snapshot', () => {
    const { emit } = renderFinder();
    // The authoritative snapshot (an afterSeq 0 join) carries the persisted
    // cinema row — the cinema event itself is never replayed to such a client.
    emit(
      makeEnvelope({
        event: 'state',
        payload: {
          cinema: {
            session_id: 's1',
            playing: true,
            position: 30,
            updated_at: Date.now() - 5000,
            movie: { id: 550, title: 'Fight Club', year: 1999 },
          },
        },
      }) as unknown as ServerEnvelope,
    );
    // Discovery first — the inherited movie is offered as a resume card.
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    expect(screen.getByText('Now watching')).toBeTruthy();
    expect(screen.getByText(/Fight Club/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    // The player resumes from the wall-clock-advanced position once metadata
    // loads, and the peer's playback state is applied.
    expect(screen.getByRole('button', { name: 'Pause playback' })).toBeTruthy();
    const video = document.querySelector('video') as HTMLVideoElement;
    expect(video).toBeTruthy();
    fireEvent(video, new Event('loadedmetadata'));
    expect(video.currentTime).toBeGreaterThanOrEqual(35);
    expect(video.currentTime).toBeLessThanOrEqual(35.5);
  });

  it('sends a cinema toggle exactly once per click and mirrors the peer', () => {
    const { conn, emit } = renderFinder();
    // A session with a chosen movie — discovery offers it as a resume card.
    emit(
      makeEnvelope({
        event: 'state',
        payload: {
          cinema: {
            session_id: 's1',
            playing: false,
            position: 0,
            updated_at: Date.now(),
            movie: { id: 550, title: 'Fight Club', year: 1999 },
          },
        },
      }) as unknown as ServerEnvelope,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));

    const modal = screen.getByRole('dialog') as HTMLElement;
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

  it("treats the echo of our own cinema action as a no-op (no phantom peer log)", async () => {
    const { conn, emit, emitRaw } = renderFinder();
    emit(
      makeEnvelope({
        event: 'state',
        payload: {
          cinema: {
            session_id: 's1',
            playing: false,
            position: 0,
            updated_at: Date.now(),
            movie: { id: 550, title: 'Fight Club', year: 1999 },
          },
        },
      }) as unknown as ServerEnvelope,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));

    const modal = screen.getByRole('dialog') as HTMLElement;
    const play = modal.querySelector('button.btn-primary') as HTMLButtonElement;

    // The server echoes cinema events back to the sender. The echo can be
    // handled before React commits the click's new play state (same event
    // turn), which used to misread the echo as a peer action and log a
    // phantom "<peer> pressed PLAY". The no-op check must compare against
    // the synchronously-updated shared state, not the rendered isPlaying.
    await act(async () => {
      play.click();
      emitRaw(
        makeEnvelope({ event: 'cinema', payload: { playing: true, position: 0 } }) as ServerEnvelope,
      );
    });

    // Exactly one outbound frame (the click), and no peer log line.
    expect(conn.send).toHaveBeenCalledTimes(1);
    expect(conn.send).toHaveBeenCalledWith('cinema', { playing: true, position: 0 });
    expect(screen.queryByText(/Bob pressed PLAY/)).toBeNull();
    expect(screen.queryByText(/Bob pressed PAUSE/)).toBeNull();
  });

  it("treats the echo as a no-op even when the position wrapped across the loop", async () => {
    const { conn, emit, emitRaw } = renderFinder();
    emit(
      makeEnvelope({
        event: 'state',
        payload: {
          cinema: {
            session_id: 's1',
            playing: false,
            position: 33.2,
            updated_at: Date.now(),
            movie: { id: 550, title: 'Fight Club', year: 1999 },
          },
        },
      }) as unknown as ServerEnvelope,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));

    // Give the clip a real duration. A real browser wraps currentTime to 0.2
    // on the loop; jsdom does not, so set it explicitly — the raw positions
    // then differ by a full loop, exactly what the normalization absorbs.
    const video = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(video, 'duration', { value: 33, configurable: true });
    fireEvent(video, new Event('loadedmetadata'));
    video.currentTime = 0.2;

    await act(async () => {
      emitRaw(
        makeEnvelope({ event: 'cinema', payload: { playing: false, position: 33.2 } }) as ServerEnvelope,
      );
    });

    // No outbound frame and no phantom peer log line.
    expect(conn.send).not.toHaveBeenCalled();
    expect(screen.queryByText(/Bob pressed PAUSE/)).toBeNull();
    expect(screen.queryByText(/Bob pressed PLAY/)).toBeNull();
  });

  it('seeks propagate to the peer and re-anchor local playback', () => {
    const { conn, emit } = renderFinder();
    emit(
      makeEnvelope({
        event: 'state',
        payload: {
          cinema: {
            session_id: 's1',
            playing: false,
            position: 0,
            updated_at: Date.now(),
            movie: { id: 550, title: 'Fight Club', year: 1999 },
          },
        },
      }) as unknown as ServerEnvelope,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));

    const seek = screen.getByLabelText('Seek video') as HTMLInputElement;
    // Range inputs fire native `input` events on drag (React binds onChange to it).
    fireEvent.input(seek, { target: { value: '15' } });
    expect(conn.send).toHaveBeenCalledWith('cinema', { playing: false, position: 15 });
    expect(document.querySelector('video')!.currentTime).toBe(15);
  });

  it('sends completed canvas strokes via pointer events (mouse and touch) and clears exactly once', () => {
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Canvas' }));

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
        countryA="United States"
        countryB="Japan"
        windowMinutes={45}
      />,
    );

    // The activity opens and the canonical timer action fires exactly once.
    expect(screen.getByRole('dialog', { name: 'Focus' })).toBeTruthy();
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
        countryA="United States"
        countryB="Japan"
        windowMinutes={45}
      />,
    );
    expect(fake.conn.send).toHaveBeenCalledTimes(1);
  });

  it('opens the Watch discovery from a Start Together launch without inventing events', () => {
    const fake = createFakeConnection('a');
    render(
      <ActivityFinder
        nameA="Alice"
        nameB="Bob"
        connection={fake.conn}
        hasPeer={false}
        launchRequest={{ type: 'cinema', nonce: 7 }}
        countryA="United States"
        countryB="Japan"
        windowMinutes={45}
      />,
    );
    // The launch lands on discovery — the movie choice is the watch decision,
    // and playback only starts once one is picked (no invented events).
    expect(screen.getByText('What do we want to watch?')).toBeTruthy();
    expect(fake.conn.send).not.toHaveBeenCalled();
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
        countryA="United States"
        countryB="Japan"
        windowMinutes={45}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Canvas' })).toBeTruthy();
    expect(fake.conn.send).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------
  // Watch 2.0 — discovery, search, detail, availability
  // ----------------------------------------------------

  it('opens to discovery and searches a movie', async () => {
    stubWatchFetch();
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));

    // Discovery first — search box and pick-for-us, no player yet.
    expect(screen.getByText('What do we want to watch?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /pick something for us/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /play playback/i })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search movies'), { target: { value: 'fight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const result = await screen.findByRole('button', { name: /Open Fight Club/ });
    expect(result).toBeTruthy();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('shows both-region availability on the movie detail and starts the watch together', async () => {
    stubWatchFetch();
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));

    fireEvent.change(screen.getByLabelText('Search movies'), { target: { value: 'fight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const result = await screen.findByRole('button', { name: /Open Fight Club/ });
    fireEvent.click(result);

    // Detail: both regions listed with honest availability.
    expect(await screen.findByText('United States')).toBeTruthy();
    expect(screen.getByText('Netflix')).toBeTruthy();
    expect(screen.getByText('Japan')).toBeTruthy();
    expect(screen.getByText('Not available')).toBeTruthy();
    // The detail fetch filled in the runtime the search row lacked.
    expect(screen.getByText('1999 · 139 min')).toBeTruthy();

    // Watch together sends the movie with the start action and opens the player.
    fireEvent.click(screen.getByRole('button', { name: 'Watch together' }));
    expect(conn.send).toHaveBeenCalledWith(
      'cinema',
      expect.objectContaining({
        playing: true,
        position: 0,
        movie: expect.objectContaining({ id: 550, title: 'Fight Club' }),
      }),
    );
    expect(screen.getByText('Now watching')).toBeTruthy();
    expect(screen.getByRole('button', { name: /play playback|pause playback/i })).toBeTruthy();
  });

  it('handles an unavailable watch service honestly (no fake results)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response),
    );
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));

    fireEvent.change(screen.getByLabelText('Search movies'), { target: { value: 'fight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/watch search isn't configured/i)).toBeTruthy();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('pick-for-us surfaces the deterministic pick and its candidates', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/watch/pick')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            windowMinutes: 45,
            movies: [SAMPLE_MOVIE],
            pick: SAMPLE_MOVIE,
            pickReason: 'deterministic',
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }));
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));

    fireEvent.click(screen.getByRole('button', { name: /pick something for us/i }));
    expect(await screen.findByText(/fits your 45-minute window/i)).toBeTruthy();
    expect(screen.getByText('our pick')).toBeTruthy();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('shows an honest per-country availability row even when a region has no provider data', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/watch/search')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, query: 'fight', movies: [SAMPLE_MOVIE] }),
        } as Response;
      }
      if (url.includes('/availability')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            movieId: 550,
            regions: [{ region: 'US', country: 'United States', providers: ['Netflix'] }],
          }),
        } as Response;
      }
      if (/\/api\/watch\/\d+$/.test(url)) {
        return { ok: true, status: 200, json: async () => ({ ok: true, movie: SAMPLE_MOVIE }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }));
    const { conn } = renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    fireEvent.change(screen.getByLabelText('Search movies'), { target: { value: 'fight' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const result = await screen.findByRole('button', { name: /Open Fight Club/ });
    fireEvent.click(result);

    // The region the provider has no data for reads "Availability unavailable"
    // — the known-available region still shows its providers, never a fake check.
    expect(await screen.findByText('United States')).toBeTruthy();
    expect(screen.getByText('Netflix')).toBeTruthy();
    expect(screen.getByText('Japan')).toBeTruthy();
    expect(screen.getByText('Availability unavailable')).toBeTruthy();
    expect(screen.queryByText('Not available')).toBeNull();
    expect(conn.send).not.toHaveBeenCalled();
  });

  it('reports no short options when nothing fits the shared window', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/watch/pick')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            windowMinutes: 45,
            movies: [],
            pick: null,
            pickReason: 'no-fit',
          }),
        } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }));
    renderFinder();
    fireEvent.click(screen.getByRole('button', { name: 'Open Watch' }));
    fireEvent.click(screen.getByRole('button', { name: /pick something for us/i }));
    expect(await screen.findByText(/nothing in the popular list fits/i)).toBeTruthy();
  });
});
