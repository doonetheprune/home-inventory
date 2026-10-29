/**
 * Just enough YAML for Home Assistant: mappings, lists, strings, numbers and
 * booleans, in block style the way Home Assistant writes automations.yaml.
 */

type Value = string | number | boolean | null | Value[] | { [k: string]: Value };

const RESERVED = /^(true|false|yes|no|on|off|null|y|n|~)$/i;

/** A string as-is when YAML would read it back the same, otherwise in double quotes. */
export function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  // A colon is fine inside a word ("mdi:cart"), not before a space or at the end.
  if (/^[A-Za-z][A-Za-z0-9 _.,()/:-]*$/.test(v) && !/:( |$)/.test(v) && !RESERVED.test(v) && !v.endsWith(' ')) return v;
  return JSON.stringify(v);
}

const isScalar = (v: Value): v is string | number | boolean | null => v === null || typeof v !== 'object';

function lines(v: Value, indent: string): string[] {
  if (isScalar(v)) return [`${indent}${scalar(v)}`];
  if (Array.isArray(v)) {
    if (!v.length) return [`${indent}[]`];
    return v.flatMap((item) => {
      const inner = lines(item, `${indent}  `);
      return [`${indent}- ${inner[0]!.slice(indent.length + 2)}`, ...inner.slice(1)];
    });
  }
  const entries = Object.entries(v);
  if (!entries.length) return [`${indent}{}`];
  return entries.flatMap(([k, val]) => {
    if (isScalar(val) || (Array.isArray(val) && !val.length) || (!Array.isArray(val) && !Object.keys(val).length)) {
      return [`${indent}${scalar(k)}: ${lines(val, '')[0]}`];
    }
    return [`${indent}${scalar(k)}:`, ...lines(val, `${indent}  `)];
  });
}

/** YAML for a value, with optional `# comment` lines on top. */
export function toYaml(value: unknown, comments: string[] = []): string {
  return [...comments.map((c) => `# ${c}`.trimEnd()), ...lines(value as Value, '')].join('\n') + '\n';
}
