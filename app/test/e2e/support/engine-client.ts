// A second protocol client of the engine the renderer is on (the helper of
// read-model.spec.ts): its commits are not the renderer's. With events it also
// subscribes to the event stream and keeps every event apart from the replies.

import type { Page } from '@playwright/test';

export type Reply = { requestId?: string; ok?: boolean; result?: Record<string, unknown>; error?: { code: string } };
export type EngineEvent = { schema: string; seq: string; type: string } & Record<string, unknown>;

let calls = 0;

export interface EngineClient {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  // The error code of a call that must fail.
  refused(method: string, params?: Record<string, unknown>): Promise<string>;
  // Events received so far (subscribed clients only).
  readonly events: EngineEvent[];
  ofType(type: string): EngineEvent[];
  readonly auth: Record<string, unknown>;
  close(): void;
}

export async function engineClient(page: Page, options: { events?: boolean } = {}): Promise<EngineClient> {
  const endpoint = await page.evaluate(() =>
    (window as unknown as { siann: { engine: { current(): Promise<{ port: number; token: string } | null> } } }).siann.engine.current(),
  );
  if (endpoint === null) throw new Error('the renderer has no engine');
  const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}/`);
  const replies: Reply[] = [];
  const events: EngineEvent[] = [];
  let wake = () => {};
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (message.schema === 'siann.event.v1') events.push(message as EngineEvent);
    else replies.push(message as Reply);
    wake();
  });
  const next = async (): Promise<Reply> => {
    while (replies.length === 0) await new Promise<void>((resolve) => (wake = resolve));
    return replies.shift()!;
  };
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  socket.send(JSON.stringify({ type: 'auth', token: endpoint.token, events: options.events === true }));
  const auth = (await next()) as Record<string, unknown>;
  const sessionId = auth.sessionId as string;
  const send = async (method: string, params: Record<string, unknown>): Promise<Reply> => {
    // A new id each time: the server answers a repeated one from its idempotency cache.
    const requestId = `req_e2e_${process.pid}_${++calls}`;
    socket.send(JSON.stringify({ requestId, sessionId, method, params }));
    for (;;) {
      const reply = await next();
      if (reply.requestId === requestId) return reply;
    }
  };
  return {
    async call(method, params = {}) {
      const reply = await send(method, params);
      if (!reply.ok) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
      return reply.result!;
    },
    async refused(method, params = {}) {
      const reply = await send(method, params);
      if (reply.ok) throw new Error(`${method} was accepted`);
      return reply.error!.code;
    },
    events,
    ofType: (type) => events.filter((e) => e.type === type),
    auth,
    close: () => socket.close(),
  };
}
