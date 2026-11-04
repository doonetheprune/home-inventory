/** Short codes for places, as printed on labels (G2-4). */

/**
 * The code to offer for a new spot inside a place with a code: the place's code
 * and the next number, following the spots already there ("G" → G1, G2…; "CF"
 * with CF-1 and CF-2 → CF-3). After a number a dash keeps it readable ("G1" →
 * G1-1, as a grid of shelves does). Null when the place has no code.
 */
export function nextPlaceCode(parentCode: string | null | undefined, taken: Iterable<string | null | undefined>): string | null {
  const base = parentCode?.trim().toUpperCase();
  if (!base) return null;
  const used = new Set<string>();
  for (const c of taken) if (c) used.add(c.trim().toUpperCase());
  const afterNumber = /\d$/.test(base);
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}(${afterNumber ? '-' : '-?'})(\\d+)$`);
  let sep: string | null = null;
  let last = 0;
  for (const c of used) {
    const m = pattern.exec(c);
    if (!m) continue;
    sep ??= m[1]!;
    last = Math.max(last, Number(m[2]));
  }
  sep ??= afterNumber ? '-' : '';
  for (let n = last + 1; ; n++) {
    const code = `${base}${sep}${n}`;
    if (code.length > 20) return null;
    if (!used.has(code)) return code;
  }
}
