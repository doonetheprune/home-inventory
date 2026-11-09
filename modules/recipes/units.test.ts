import { describe, expect, it } from 'vitest';
import { convert, measureText, unitKey } from './units';

describe('recipe units', () => {
  it('reads units however they are written', () => {
    expect(['Grams', 'kilos', 'tablespoons', 'fl oz', 'Slices', 'each', '', 'tomatoes', 'pinches'].map((u) => unitKey(u))).toEqual(['g', 'kg', 'tbsp', 'floz', 'slice', '', '', 'tomato', 'pinch']);
  });

  it('converts between kitchen measures of the same kind, and nothing else', () => {
    expect(convert(1, 'kg', 'g')).toBe(1000);
    expect(convert(2, 'tbsp', 'tsp')).toBe(6);
    expect(convert(1, 'lb', 'oz')).toBeCloseTo(16);
    expect(convert(1, 'pint', 'ml')).toBeCloseTo(568.26);
    expect(convert(1, 'litre', 'cl')).toBe(100);
    expect(convert(1, 'g', 'ml')).toBeNull();
    expect(convert(3, 'slice', 'slices')).toBe(3);
    expect(convert(1, 'cup', 'g')).toBeNull();
  });

  it('counts the same thing, but never turns 8 chicken thighs into 8 packs', () => {
    expect(convert(2, '', 'egg', ['eggs', 'Free-range eggs'])).toBe(2);
    expect(convert(2, 'eggs', '', ['eggs'])).toBe(2);
    expect(convert(8, '', 'pack', ['chicken thighs', 'Chicken thighs'])).toBeNull();
    expect(convert(1, 'cup', '')).toBeNull();
  });

  it('rounds amounts the way a cook would measure them', () => {
    expect(measureText(66.6667, 'g')).toBe('67 g');
    expect(measureText(1.5, 'l')).toBe('1.5 L');
    expect(measureText(1, 'litre')).toBe('1 L');
    expect(measureText(2, 'pints')).toBe('2 pints');
    expect(measureText(0.333, 'tsp')).toBe('0.33 tsp');
    expect(measureText(2.6667, '')).toBe('2.7');
    expect(measureText(3, 'slice')).toBe('3 slices');
    expect(measureText(1, 'slices')).toBe('1 slice');
  });
});
