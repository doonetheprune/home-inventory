/**
 * The unit list and the converter (src/core/services/units.ts): the only place Larder
 * turns an amount into what an item is bought in.
 */
import { describe, expect, it } from 'vitest';
import {
  amountText, asWeight, boughtInText, builtInUnits as units, canConvert, containsText, fromBoughtIn, givenInText, lastsText, newUnit, periodsPerTake,
  stockText, toBoughtIn, unitList, UnknownUnitError, usageInBoughtIn, usageText, weightText,
} from '../../src/core/services/units';

const sleep = { name: 'Twinings Sleep', unit: 'box', contents: { amount: 20, unit: 'tea bag' }, weight: null };
const decaf = { name: 'Decaf coffee', unit: 'jar', contents: { amount: 400, unit: 'g' }, weight: { amount: 400, unit: 'g' } };
const milk = { name: 'Whole milk', unit: 'bottle', contents: { amount: 4, unit: 'pint' }, weight: { amount: 2273.044, unit: 'ml' } };
const loo = { name: 'Toilet roll', unit: 'roll', contents: { amount: 200, unit: 'sheet' }, weight: null };
const cheddar = { name: 'Loose cheddar', unit: 'g', contents: null, weight: null };
const drill = { name: 'Cordless drill', unit: 'each', contents: null, weight: { amount: 1600, unit: 'g' } };

describe('the unit list', () => {
  it('finds a unit by its key, one, many, any case and common spellings', () => {
    for (const [word, key] of [['Tea bags', 'tea bag'], ['teabags', 'tea bag'], ['TEA-BAG', 'tea bag'], ['Boxes', 'box'], ['kgs', 'kg'], ['Kilos', 'kg'], ['litre', 'l'], ['L', 'l'],
      ['pkt', 'packet'], ['pints', 'pint'], ['grams', 'g'], ['ones', 'each'], ['', null], ['loaves', 'loaf'], ['batteries', 'battery'], ['m', 'metre'], ['tabs', 'tablet']] as const) {
      expect([word, units.find(word)?.key ?? null]).toEqual([word, key]);
    }
    expect(units.find('sleeve')).toBeNull();
    expect(units.find('4 pint bottle')).toBeNull();
  });

  it('knows what kind each is, and its plural', () => {
    expect(units.find('tea bag')).toMatchObject({ one: 'tea bag', many: 'tea bags', kind: 'count', factor: null, builtIn: true });
    expect(units.find('kg')).toMatchObject({ kind: 'weight', factor: 1000 });
    expect(units.find('pint')).toMatchObject({ kind: 'volume', factor: 568.261, many: 'pints' });
    expect(units.find('l')).toMatchObject({ one: 'L', many: 'L', factor: 1000 });
    // Every key is the singular in lower case, and none is listed twice.
    const keys = units.all.map((u) => u.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const u of units.all) expect(u.key).toBe(u.one.toLowerCase());
  });

  it('takes the household\'s own count words, refusing ones it already has', () => {
    const mine = unitList([{ one: 'Sleeve', many: 'Sleeves' }]);
    expect(mine.find('sleeves')).toMatchObject({ key: 'sleeve', one: 'Sleeve', kind: 'count', builtIn: false });
    expect(newUnit(units, { one: ' sleeve ', many: 'sleeves' })).toEqual({ one: 'sleeve', many: 'sleeves' });
    expect(() => newUnit(units, { one: 'Box', many: 'Boxes' })).toThrow('Larder already has "box".');
    expect(() => newUnit(units, { one: 'pkt', many: 'pkts' })).toThrow('Larder already has "packet", which "pkt" means.');
    expect(() => newUnit(mine, { one: 'sleeve', many: 'sleeves' })).toThrow('Larder already has "Sleeve" (added by the household).');
    expect(() => newUnit(units, { one: 'sleeve of 50', many: 'sleeves of 50' })).toThrow('A unit is a word, without a number');
  });
});

describe('the converter', () => {
  it('1. takes what it is bought in as it is', () => {
    expect(toBoughtIn(units, sleep, 2)).toBe(2);
    expect(toBoughtIn(units, sleep, 2, 'boxes')).toBe(2);
    expect(toBoughtIn(units, drill, 1, 'ones')).toBe(1);
    // An old item's unit that isn't on the list still works as itself.
    expect(toBoughtIn(units, { name: 'Milk', unit: '4 pint bottle' }, 2, '4 pint bottle')).toBe(2);
  });

  it('2. divides what one contains, when that is a count', () => {
    expect(toBoughtIn(units, sleep, 5, 'tea bags')).toBe(0.25);
    expect(fromBoughtIn(units, sleep, 3.95, 'tea bag')).toBeCloseTo(79);
    expect(toBoughtIn(units, loo, 100, 'sheets')).toBe(0.5);
  });

  it('3. goes through Weight for g, kg, ml, L and pints, never through Contains', () => {
    expect(toBoughtIn(units, decaf, 100, 'g')).toBe(0.25);
    expect(toBoughtIn(units, decaf, 0.2, 'kg')).toBe(0.5);
    expect(toBoughtIn(units, milk, 1, 'pint')).toBeCloseTo(0.25);
    expect(toBoughtIn(units, milk, 568.261, 'ml')).toBeCloseTo(0.25);
    expect(fromBoughtIn(units, decaf, 0.75, 'g')).toBe(300);
    // Contains says 400 g, but without a Weight Larder can't work in grams.
    expect(() => toBoughtIn(units, { ...decaf, weight: null }, 100, 'g')).toThrow("Larder doesn't know what one jar of Decaf coffee weighs, so it can't work in g. Give how many jars. Or give it a Weight first.");
    // Weight can be given for anything, even tea bags in a box.
    expect(toBoughtIn(units, { ...sleep, weight: { amount: 30, unit: 'g' } }, 15, 'g')).toBe(0.5);
    expect(toBoughtIn(units, drill, 3.2, 'kg')).toBe(2);
  });

  it('takes things bought loose in any weight, as g', () => {
    expect(toBoughtIn(units, cheddar, 0.2, 'kg')).toBe(200);
    expect(toBoughtIn(units, cheddar, 350, 'g')).toBe(350);
    expect(() => toBoughtIn(units, cheddar, 1, 'L')).toThrow('Loose cheddar is bought loose, by weight, so it can\'t be given in L. Give how much in g or kg.');
  });

  it('refuses a weight asked of something with a volume, and the other way round', () => {
    expect(() => toBoughtIn(units, milk, 100, 'g')).toThrow('One bottle of Whole milk holds 2273 ml, so it can\'t be given in g: a weight can\'t be worked out from a volume. Give how many bottles, or how much in ml, cl, L or pints.');
    expect(() => toBoughtIn(units, decaf, 100, 'ml')).toThrow('a volume can\'t be worked out from a weight');
  });

  it('says what an item can be given in when it can\'t be', () => {
    expect(() => toBoughtIn(units, sleep, 1, 'jar')).toThrow('Twinings Sleep is bought in boxes, each containing 20 tea bags. Give how many boxes or tea bags.');
    expect(() => toBoughtIn(units, drill, 1, 'box')).toThrow('Cordless drill is counted one by one. Give how many, or how much in g or kg.');
    expect(givenInText(units, decaf)).toBe('Give how many jars, or how much in g or kg.');
    expect(canConvert(units, sleep, 'g')).toBe(false);
    expect(canConvert(units, decaf, 'kg')).toBe(true);
  });

  it('refuses a unit that is not on the list', () => {
    expect(() => toBoughtIn(units, sleep, 1, 'sleeve')).toThrow(UnknownUnitError);
    expect(() => toBoughtIn(units, sleep, 1, 'sleeve')).toThrow('Larder doesn\'t have the unit "sleeve".');
  });

  it('keeps a Weight in g or ml: kg, L and pints are only for typing', () => {
    expect(asWeight(units, { amount: 1, unit: 'kg' })).toEqual({ amount: 1000, unit: 'g' });
    expect(asWeight(units, { amount: 4, unit: 'pints' })).toEqual({ amount: 2273.044, unit: 'ml' });
    expect(asWeight(units, { amount: 1.5, unit: 'L' })).toEqual({ amount: 1500, unit: 'ml' });
    expect(asWeight(units, { amount: 20, unit: 'tea bag' })).toBeNull();
  });

  it('turns a usage into what it is bought in, a little at a time', () => {
    expect(usageInBoughtIn(units, { ...sleep, usage: { amount: 1, everyDays: 1, unit: 'tea bag' } })).toEqual({ amount: 0.05, everyDays: 1 });
    expect(usageInBoughtIn(units, { ...decaf, usage: { amount: 4, everyDays: 1, unit: 'g' } })).toEqual({ amount: 0.01, everyDays: 1 });
    expect(usageInBoughtIn(units, { ...sleep, usage: { amount: 1, everyDays: 7, unit: null } })).toEqual({ amount: 1, everyDays: 7 });
    expect(usageInBoughtIn(units, { ...sleep, usage: { amount: 4, everyDays: 1, unit: 'g' } })).toBeNull();
    // 1 tea bag a day from a box of 80 is 0.0125 a day: taken 0.025 every 2 days, so it rounds cleanly.
    expect(periodsPerTake(1 / 80)).toBe(2);
    expect(periodsPerTake(0.05)).toBe(1);
  });
});

describe('saying amounts', () => {
  it('says stock in what it is bought in, in quarters when part of one is left', () => {
    expect(stockText(units, sleep, 4)).toBe('4 boxes');
    expect(stockText(units, sleep, 1)).toBe('1 box');
    expect(stockText(units, sleep, 3.75)).toBe('about 3¾ boxes');
    expect(stockText(units, sleep, 3.95)).toBe('about 4 boxes');
    expect(stockText(units, decaf, 0.75)).toBe('about ¾ jar');
    expect(stockText(units, decaf, 0.04)).toBe('about ¼ jar');
    expect(stockText(units, cheddar, 350)).toBe('350 g');
    expect(stockText(units, cheddar, 1600)).toBe('1.6 kg');
    expect(stockText(units, drill, 1)).toBe('1');
    expect(stockText(units, drill, 1.5)).toBe('about 1½');
  });

  it('says amounts, Contains, Weight and Bought in', () => {
    expect(amountText(units, 2, 'tea bag')).toBe('2 tea bags');
    expect(amountText(units, 1, 'battery')).toBe('1 battery');
    expect(amountText(units, 300000, 'ml')).toBe('300 L');
    expect(amountText(units, 3, 'each')).toBe('3');
    expect(amountText(units, 2, '4 pint bottle')).toBe('2 4 pint bottles');
    expect(containsText(units, sleep)).toBe('Each box contains 20 tea bags');
    expect(containsText(units, { unit: 'bag', contents: { amount: 1, unit: 'kg' } })).toBe('Each bag contains 1 kg');
    expect(containsText(units, cheddar)).toBeNull();
    expect(weightText({ amount: 2273.044, unit: 'ml' })).toBe('2273 ml');
    expect(weightText({ amount: 1.5, unit: 'g' })).toBe('1.5 g');
    expect([boughtInText(units, sleep), boughtInText(units, drill), boughtInText(units, cheddar), boughtInText(units, { unit: '4 pint bottle' })])
      .toEqual(['Bought in boxes', 'Bought one at a time', 'Bought loose, by weight (g)', 'Bought in "4 pint bottle" (not on the unit list)']);
  });

  it('says how fast it goes, and how long one lasts', () => {
    const s = { ...sleep, usage: { amount: 1, everyDays: 1, unit: 'tea bag' } };
    expect(usageText(units, s)).toBe('1 tea bag a day');
    expect(lastsText(units, s)).toBe('a box lasts 20 days');
    const d = { ...decaf, usage: { amount: 4, everyDays: 1, unit: 'g' } };
    expect([usageText(units, d), lastsText(units, d)]).toEqual(['4 g a day', 'a jar lasts 100 days']);
    const sensor = { name: 'Sensor', unit: 'sensor', usage: { amount: 1, everyDays: 14, unit: null } };
    expect([usageText(units, sensor), lastsText(units, sensor)]).toEqual(['1 sensor every 2 weeks', 'a sensor lasts 2 weeks']);
    expect(lastsText(units, { ...cheddar, usage: { amount: 50, everyDays: 1 } })).toBeNull();
  });
});
