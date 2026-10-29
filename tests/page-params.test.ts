import { describe, expect, it } from 'vitest';
import { matchPath } from '../src/web/src/sdk/paths';

describe('module page parameters', () => {
  it('match plain segments and decode them', () => {
    expect(matchPath('/:id/print', '/abc-123/print')).toEqual({ id: 'abc-123' });
    expect(matchPath('/:id', '/Power%20cut')).toEqual({ id: 'Power cut' });
    expect(matchPath('/:id/print', '/abc')).toBeNull();
  });

  it('refuse anything that could reach another API path, or that would crash the page', () => {
    expect(matchPath('/:id/edit', '/..%2F..%2Fproducts%2Fx/edit')).toBeNull();
    expect(matchPath('/:id', '/..')).toBeNull();
    expect(matchPath('/:id', '/%2e%2e')).toBeNull();
    expect(matchPath('/:id', '/a%5Cb')).toBeNull();
    expect(matchPath('/:id', '/%E0%A4%A')).toBeNull();
  });
});
