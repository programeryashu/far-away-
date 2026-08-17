// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimezoneSync } from './TimezoneSync';

describe('TimezoneSync', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the day timeline without duplicate-key warnings', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <TimezoneSync
        cityA={{ name: 'San Francisco', timezone: 'America/Los_Angeles' }}
        cityB={{ name: 'Tokyo', timezone: 'Asia/Tokyo' }}
        nameA="Yash"
        nameB="Kimi"
      />,
    );
    const keyWarnings = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((msg) => /same key|two children with the same key/i.test(msg));
    expect(keyWarnings).toEqual([]);
  });
});
