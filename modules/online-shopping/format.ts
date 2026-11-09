/** Words and numbers for messages and tool answers. Amounts and units are said by the core (`amountText`). */
import { amountText, isLoose, toBoughtIn, unitOf, type Units } from '@larder/core';
import type { Product } from './contract';

const SYMBOLS: Record<string, string> = { GBP: '£', EUR: '€', USD: '$' };

export function money(n: number, currency = 'GBP'): string {
  return `${SYMBOLS[currency] ?? `${currency} `}${n.toFixed(2)}`;
}

/** Prices under £1 a unit get a third decimal place when it matters: £0.313 a roll. */
export function unitMoney(n: number, currency = 'GBP'): string {
  const three = n < 1 && Math.round(n * 1000) % 10 !== 0;
  return `${SYMBOLS[currency] ?? `${currency} `}${n.toFixed(three ? 3 : 2)}`;
}

/**
 * A price per one of what it's bought in: "£0.31 a roll", "£0.50 each". Things bought loose are kept
 * per g or ml, so they're said per kg or L: "£4.40 per kg".
 */
export function perUnit(units: Units, n: number, unit: string, currency = 'GBP'): string {
  const item = { name: 'it', unit };
  if (isLoose(units, item)) {
    const big = unitOf(units, unit).kind === 'weight' ? 'kg' : 'l';
    return `${unitMoney(n * toBoughtIn(units, item, 1, big), currency)} per ${unitOf(units, big).one}`;
  }
  const u = units.find(unit);
  return u?.key === 'each' ? `${unitMoney(n, currency)} each` : `${unitMoney(n, currency)} a ${u?.one ?? unit}`;
}

/** A shop's pack size: "9", "500 g", "1.5 kg", "1 L". */
export function packSizeText(units: Units, p: Product['pack_size']): string | null {
  if (!p) return null;
  if (p.unit === 'each') return `${p.amount}`;
  const small = p.unit === 'kg' ? 'g' : 'ml';
  return amountText(units, toBoughtIn(units, { name: 'pack', unit: small }, p.amount, p.unit), small);
}

/** One line about a shop's product, for assistants. */
export function productLine(units: Units, p: Product, currency = 'GBP', loyaltyName = 'loyalty'): string {
  const parts = [`${p.name} (code ${p.listing_id})`];
  const size = packSizeText(units, p.pack_size);
  if (size) parts.push(`pack ${size}`);
  if (p.price !== null) parts.push(money(p.price, currency));
  if (p.loyalty_price !== null) parts.push(`${money(p.loyalty_price, currency)} with ${loyaltyName}`);
  return parts.join(', ');
}

export const qty = (units: Units, n: number, unit: string) => amountText(units, n, unit);
