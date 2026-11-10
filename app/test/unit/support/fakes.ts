// Test doubles shared by the renderer's protocol tests (the pattern of
// session-client.test.ts): a socket the test plays the engine's side of, a
// scheduler whose timers fire only when the test says so, and a bounded
// condition wait across event-loop turns. No network, no timers, no wall clock
// as synchronization.

import assert from 'node:assert/strict';

import type { SocketLike } from '../../../src/renderer/model/session-client';

export type Message = Record<string, unknown> & {
  requestId?: string;
  method?: string;
  params?: Record<string, unknown>;
};

export class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  binaryType = 'blob';
  readonly sent: Message[] = [];
  closedByClient = false;
  handler: ((message: Message) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    const message = JSON.parse(data) as Message;
    this.sent.push(message);
    this.handler?.(message);
  }
  close(): void {
    this.closedByClient = true;
  }
  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  deliverBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.slice().buffer });
  }
  serverClose(): void {
    this.onclose?.();
  }
  requests(method: string): Message[] {
    return this.sent.filter((m) => m.method === method);
  }
}

export interface Timer {
  fn: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

export class FakeScheduler {
  readonly timers: Timer[] = [];
  readonly schedule = (fn: () => void, ms: number): (() => void) => {
    const timer: Timer = { fn, ms, cancelled: false, fired: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  pending(): Timer[] {
    return this.timers.filter((t) => !t.cancelled && !t.fired);
  }
  fire(ms: number): void {
    const matching = this.pending().filter((t) => t.ms === ms);
    assert.equal(matching.length, 1, `one pending ${ms} ms timer`);
    matching[0]!.fired = true;
    matching[0]!.fn();
  }
}

// Polls a condition across event-loop turns (WebCrypto digests finish on the
// thread pool): gives up only after 2000 turns and 10 s.
export async function until(condition: () => boolean, what: string): Promise<void> {
  const start = performance.now();
  for (let i = 0; i < 2000 || performance.now() - start < 10_000; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${what}`);
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}
