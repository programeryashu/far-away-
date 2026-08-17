import { describe, it, expect } from 'vitest';
import { haversineKm } from './geo';

describe('haversineKm (the one shared distance implementation)', () => {
  it('returns exactly zero for identical points', () => {
    expect(haversineKm(37.77, -122.42, 37.77, -122.42)).toBe(0);
  });

  it('computes a known city pair: San Francisco to Tokyo ≈ 8,280 km', () => {
    const d = haversineKm(37.7749, -122.4194, 35.6895, 139.6917);
    expect(d).toBeGreaterThan(8_150);
    expect(d).toBeLessThan(8_400);
  });

  it('is symmetric in argument order', () => {
    const ab = haversineKm(37.7749, -122.4194, 35.6895, 139.6917);
    const ba = haversineKm(35.6895, 139.6917, 37.7749, -122.4194);
    expect(ab).toBeCloseTo(ba, 9);
  });

  it('never exceeds half the Earth circumference', () => {
    const antipodes = haversineKm(0, 0, 0, 180);
    expect(antipodes).toBeCloseTo(Math.PI * 6371, -1);
  });
});
