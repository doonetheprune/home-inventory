/** Module page paths, kept apart from React so they can be tested on their own. */

/** A parameter as it was in the link, or null if it isn't one plain segment (bad %-escapes, "/", ".."). */
function param(segment: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return null;
  }
  // Pages put parameters into API paths, so "..%2F..%2Fproducts" mustn't reach somewhere else.
  return /[/\\]/.test(value) || value === '.' || value === '..' ? null : value;
}

/** Matches "/12/print" against "/:id/print". */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(':')) {
      const value = param(b[i]!);
      if (value === null) return null;
      params[a[i]!.slice(1)] = value;
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}
