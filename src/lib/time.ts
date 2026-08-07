// Timezone + shared-window math for the "live window" headline stat.
// Kept free of any React/UI imports so both components and tests can use it.

export const getUTCOffsetHours = (timeZone: string, date: Date): number => {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const getVal = (type: string) => {
      const p = parts.find(x => x.type === type);
      return p ? parseInt(p.value, 10) : 0;
    };

    const year = getVal('year');
    const month = getVal('month') - 1;
    const day = getVal('day');
    let hour = getVal('hour');
    if (hour === 24) hour = 0;
    const minute = getVal('minute');
    const second = getVal('second');

    const localWallTime = Date.UTC(year, month, day, hour, minute, second);
    return (localWallTime - date.getTime()) / 3600000;
  } catch {
    return 0;
  }
};

export interface LiveWindowInterval {
  /** A-local fractional hour the block starts (0..24). */
  start: number;
  /** A-local fractional hour the block ends (exclusive, 0..24). */
  end: number;
}

export interface LiveWindowInfo {
  /** Total overlap hours today. */
  totalHours: number;
  /** Every overlap block of the day, in A-local hours. */
  intervals: LiveWindowInterval[];
  /** Current A-local fractional hour. */
  nowLocalA: number;
  /** True when "now" falls inside a live block. */
  active: boolean;
  /** A-local hour the current block ends (when active). */
  activeEnd: number | null;
  /** Seconds until the next block opens (when not active). */
  nextOpenIn: number | null;
}

// Both people count as "live" between 07:00 and 23:00 local time — the same
// awake window the 24-hour connection planner uses elsewhere in the app.
const AWAKE_START = 7;
const AWAKE_END = 23;

export const computeLiveWindow = (tzA: string, tzB: string, now: Date): LiveWindowInfo => {
  const offsetA = getUTCOffsetHours(tzA, now);
  const offsetB = getUTCOffsetHours(tzB, now);
  const hourDiff = offsetB - offsetA;

  // In A-local coordinates A is awake on [7, 23) and B is awake on
  // [7 - hourDiff, 23 - hourDiff). Intersect the (possibly wrapping) B arc
  // with the A arc to get today's overlap blocks.
  const sRaw = AWAKE_START - hourDiff;
  const s = ((sRaw % 24) + 24) % 24;
  const e = s + (AWAKE_END - AWAKE_START);
  const bParts: [number, number][] = e <= 24 ? [[s, e]] : [[s, 24], [0, e - 24]];

  const clamp = (lo: number, hi: number, x: number) => Math.max(lo, Math.min(hi, x));
  const intervals: LiveWindowInterval[] = [];
  for (const [ps, pe] of bParts) {
    const lo = clamp(AWAKE_START, AWAKE_END, ps);
    const hi = clamp(AWAKE_START, AWAKE_END, pe);
    if (hi > lo) intervals.push({ start: lo, end: hi });
  }
  intervals.sort((a, b) => a.start - b.start);

  const totalHours = intervals.reduce((sum, iv) => sum + (iv.end - iv.start), 0);
  const nowLocalA = ((now.getUTCHours() + now.getUTCMinutes() / 60 + offsetA) % 24 + 24) % 24;

  const activeIv = intervals.find(iv => nowLocalA >= iv.start && nowLocalA < iv.end) ?? null;
  let nextOpenIn: number | null = null;
  if (!activeIv) {
    const next = intervals.find(iv => iv.start > nowLocalA);
    const openAt = next ? next.start : (intervals[0]?.start ?? AWAKE_START) + 24;
    nextOpenIn = (openAt - nowLocalA) * 3600;
  }

  return {
    totalHours,
    intervals,
    nowLocalA,
    active: activeIv !== null,
    activeEnd: activeIv ? activeIv.end : null,
    nextOpenIn
  };
};

/** Formats a duration as M:SS (under an hour) or H:MM:SS. */
export const formatClock = (totalSeconds: number): string => {
  const total = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
