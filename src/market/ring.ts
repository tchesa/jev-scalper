/** Fixed-capacity ring buffer that keeps the most recent `capacity` items in insertion order. */
export class Ring<T> {
  private items: T[] = [];
  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }

  get length(): number {
    return this.items.length;
  }

  last(): T | undefined {
    return this.items[this.items.length - 1];
  }

  /** Items in insertion order (oldest first). Do not mutate. */
  toArray(): readonly T[] {
    return this.items;
  }

  /** Items whose `ts(item) >= since`, assuming monotone timestamps. */
  since(since: number, ts: (item: T) => number): T[] {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ts(this.items[m]!) < since) lo = m + 1;
      else hi = m;
    }
    return this.items.slice(lo);
  }

  /** Latest item with `ts(item) <= at`, assuming monotone timestamps. */
  at(at: number, ts: (item: T) => number): T | undefined {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ts(this.items[m]!) <= at) lo = m + 1;
      else hi = m;
    }
    return lo === 0 ? undefined : this.items[lo - 1];
  }
}
