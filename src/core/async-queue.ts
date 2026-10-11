export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  end(): void {
    this.done = true;
    for (const resolve of this.waiters) {
      resolve({ value: undefined as unknown as T, done: true });
    }
    this.waiters.length = 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve));
      },
    };
  }
}
