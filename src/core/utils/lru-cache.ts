/**
 * A minimal LRU (Least Recently Used) cache implementation.
 */
export class LruCache<T> {
  private cache = new Map<string, T>();

  constructor(
    private capacity: number,
    private onEvict?: (key: string, value: T) => void,
  ) {}

  /**
   * Gets a value from the cache and updates its position to most recently used.
   */
  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * Sets a value in the cache, evicting the least recently used item if at capacity.
   */
  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        const evictedValue = this.cache.get(firstKey);
        this.cache.delete(firstKey);
        if (evictedValue !== undefined && this.onEvict) {
          try {
            this.onEvict(firstKey, evictedValue);
          } catch (error) {
            console.error('Error in LruCache eviction callback', {
              key: firstKey,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    this.cache.set(key, value);
  }

  /**
   * Checks if a key exists in the cache without updating its position.
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Gets all entries in the cache (from most to least recently used).
   */
  entries(): IterableIterator<[string, T]> {
    return this.cache.entries();
  }

  /**
   * Deletes a key from the cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clears all items from the cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Gets the number of items in the cache.
   */
  get size(): number {
    return this.cache.size;
  }
}
