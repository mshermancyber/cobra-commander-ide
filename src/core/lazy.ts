export function lazy<T>(factory: () => T): { get(): T; reset(): void; loaded(): boolean } {
  let value: T | undefined;
  let initialized = false;

  return {
    get(): T {
      if (!initialized) {
        value = factory();
        initialized = true;
      }
      return value!;
    },
    reset(): void {
      value = undefined;
      initialized = false;
    },
    loaded(): boolean {
      return initialized;
    },
  };
}
