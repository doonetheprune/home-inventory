import { describe, expect, it } from 'vitest';
import { nextPlaceCode } from '../src/web/src/placeCodes';

describe('spot codes', () => {
  it('offers the place\'s code and the next number', () => {
    expect(nextPlaceCode('G', [])).toBe('G1');
    expect(nextPlaceCode('k', ['K1', 'K2', 'K4'])).toBe('K5');
    expect(nextPlaceCode('G1', ['G1'])).toBe('G1-1');
    expect(nextPlaceCode('G1', ['G1-1', 'G1-2', 'G12'])).toBe('G1-3');
  });

  it('follows how the spots already there are written, and skips codes in use', () => {
    expect(nextPlaceCode('CF', ['CF-1', 'CF-2'])).toBe('CF-3');
    expect(nextPlaceCode('G', ['G1-1', 'G4-6'])).toBe('G1');
    expect(nextPlaceCode('S', ['S1', 'S2-3', 'S3'])).toBe('S4');
  });

  it('offers nothing when the place has no code', () => {
    expect(nextPlaceCode(null, ['K1'])).toBeNull();
    expect(nextPlaceCode('  ', [])).toBeNull();
  });
});
