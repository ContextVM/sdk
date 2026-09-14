import { describe, expect, test } from 'bun:test';
import { LruCache } from './lru-cache.js';

describe('LruCache', () => {
  test('starts empty, retrieves inserted values and missing keys', () => {
    const cache = new LruCache<number>(2);

    expect(cache.size).toBe(0);
    expect(cache.get('missing')).toBeUndefined();
    cache.set('a', 1);

    expect(cache.size).toBe(1);
    expect(cache.get('a')).toBe(1);
  });

  test('preserves entries at capacity and evicts the oldest when exceeded', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.size).toBe(2);
    expect([...cache.entries()]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    cache.set('c', 3);

    expect(cache.size).toBe(2);
    expect(cache.has('a')).toBe(false);
    expect([...cache.entries()]).toEqual([
      ['b', 2],
      ['c', 3],
    ]);
  });

  test('get makes an entry most recently used before eviction', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect([...cache.entries()]).toEqual([
      ['a', 1],
      ['c', 3],
    ]);
  });

  test('updating a key replaces its value without growing or evicting', () => {
    const evictions: [string, number][] = [];
    const cache = new LruCache<number>(2, (key, value) => {
      evictions.push([key, value]);
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);

    expect(cache.size).toBe(2);
    expect(cache.has('b')).toBe(true);
    expect(cache.get('a')).toBe(10);
    expect(evictions).toEqual([]);
  });

  test('updating a key makes it most recently used before eviction', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);

    expect([...cache.entries()]).toEqual([
      ['a', 10],
      ['c', 3],
    ]);
  });

  test('onEvict receives the evicted key and its current value once', () => {
    const evictions: [string, number][] = [];
    const cache = new LruCache<number>(1, (key, value) => {
      evictions.push([key, value]);
    });
    cache.set('a', 1);
    cache.set('b', 2);

    expect(evictions).toEqual([['a', 1]]);
    expect([...cache.entries()]).toEqual([['b', 2]]);
  });

  test('has checks membership without changing recency', () => {
    const cache = new LruCache<number>(2);
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.has('a')).toBe(true);
    expect(cache.has('missing')).toBe(false);
    cache.set('c', 3);

    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
  });

  test('stores and retrieves an empty-string key', () => {
    const cache = new LruCache<number>(2);
    cache.set('', 1);

    expect(cache.has('')).toBe(true);
    expect(cache.get('')).toBe(1);
    expect(cache.size).toBe(1);
  });

  test('evicts an empty-string key when it is the oldest entry', () => {
    const evictions: [string, number][] = [];
    const cache = new LruCache<number>(2, (key, value) => {
      evictions.push([key, value]);
    });
    cache.set('', 1);
    cache.set('a', 2);
    cache.set('b', 3);

    expect(cache.has('')).toBe(false);
    expect([...cache.entries()]).toEqual([
      ['a', 2],
      ['b', 3],
    ]);
    expect(evictions).toEqual([['', 1]]);
  });

  test('delete reports removal and updates size without calling onEvict', () => {
    const evictions: [string, number][] = [];
    const cache = new LruCache<number>(2, (key, value) => {
      evictions.push([key, value]);
    });
    cache.set('a', 1);
    cache.set('b', 2);

    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(1);
    expect(cache.delete('a')).toBe(false);
    expect(cache.size).toBe(1);
    expect([...cache.entries()]).toEqual([['b', 2]]);
    expect(evictions).toEqual([]);
  });

  test('clear empties the cache without calling onEvict and allows reuse', () => {
    const evictions: [string, number][] = [];
    const cache = new LruCache<number>(2, (key, value) => {
      evictions.push([key, value]);
    });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(false);
    expect([...cache.entries()]).toEqual([]);

    cache.clear();
    cache.set('c', 3);

    expect(cache.size).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(evictions).toEqual([]);
  });

  test('entries iterates from least to most recently used without reordering', () => {
    const cache = new LruCache<number>(3);
    expect([...cache.entries()]).toEqual([]);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.get('a');
    cache.set('b', 20);

    expect([...cache.entries()]).toEqual([
      ['c', 3],
      ['a', 1],
      ['b', 20],
    ]);
    cache.set('d', 4);

    expect([...cache.entries()]).toEqual([
      ['a', 1],
      ['b', 20],
      ['d', 4],
    ]);
  });
});
