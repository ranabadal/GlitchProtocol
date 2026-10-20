// A single time source for the server so tests can move time forward
// (for example to check mission timeouts) without waiting.
let offsetMs = 0;

export function now(): number {
  return Date.now() + offsetMs;
}

export function __advanceClockForTests(ms: number): void {
  offsetMs += ms;
}

export function __resetClockForTests(): void {
  offsetMs = 0;
}
