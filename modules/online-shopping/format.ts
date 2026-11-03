/** Words and numbers for messages and tool answers. */
import { amount } from '@larder/core';
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

/** "£0.31 a roll", "£4.40 a kg", "£0.50 each" */
export const perUnit = (n: number, unit: string, currency = 'GBP') => (unit === 'each' ? `${unitMoney(n, currency)} each` : `${unitMoney(n, currency)} a ${unit}`);

export const packSizeText = (p: Product['pack_size']) => (p ? (p.unit === 'each' ? `${p.amount}` : p.amount < 1 && p.unit === 'kg' ? `${Math.round(p.amount * 1000)} g` : p.amount < 1 && p.unit === 'l' ? `${Math.round(p.amount * 1000)} ml` : `${p.amount} ${p.unit}`) : null);

/** One line about a shop's product, for assistants. */
export function productLine(p: Product, currency = 'GBP', loyaltyName = 'loyalty'): string {
  const parts = [`${p.name} (code ${p.listing_id})`];
  const size = packSizeText(p.pack_size);
  if (size) parts.push(`pack ${size}`);
  if (p.price !== null) parts.push(money(p.price, currency));
  if (p.loyalty_price !== null) parts.push(`${money(p.loyalty_price, currency)} with ${loyaltyName}`);
  return parts.join(', ');
}

export const qty = (n: number, unit: string) => amount(n, unit);
