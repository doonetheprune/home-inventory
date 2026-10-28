/**
 * In-app fuzzy search using MiniSearch: typo-tolerant ("bog rol", "battries"),
 * prefix matching ("batt"), and exact codes ("G2-4").
 */
import MiniSearch from 'minisearch';
import type { SearchDoc, SearchHit, SearchIndex } from '@larder/core';

/** Split on spaces and punctuation but keep codes like G2-4 and CF-2 whole. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,·›/()&'’"!?:;.]+/)
    .filter(Boolean);
}

export function createMemorySearchIndex(): SearchIndex {
  const make = () =>
    new MiniSearch<SearchDoc & { keywordText: string }>({
      fields: ['title', 'keywordText'],
      storeFields: ['type', 'refId'],
      tokenize,
      searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: (term) => (term.length > 3 ? 0.25 : term.length > 2 ? 1 : 0), combineWith: 'AND' },
    });
  let index = make();
  const prep = (d: SearchDoc) => ({ ...d, keywordText: d.keywords.join(' ') });

  return {
    async replaceAll(docs) {
      index = make();
      index.addAll(docs.map(prep));
    },
    async upsert(docs) {
      for (const d of docs) {
        if (index.has(d.id)) index.discard(d.id);
        index.add(prep(d));
      }
    },
    async remove(ids) {
      for (const id of ids) if (index.has(id)) index.discard(id);
    },
    async query(text, options = {}) {
      const types = options.types ? new Set(options.types) : null;
      let hits = index.search(text);
      // If every word must match and nothing does, fall back to any word.
      if (!hits.length && /\s/.test(text.trim())) hits = index.search(text, { combineWith: 'OR' });
      return hits
        .filter((h) => !types || types.has(h.type as string))
        .slice(0, options.limit ?? 50)
        .map((h): SearchHit => ({ id: String(h.id), type: h.type as string, refId: h.refId as string, score: h.score }));
    },
  };
}
