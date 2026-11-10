// The renderer entry (bundled by scripts/bundle-renderer.js). It connects a
// SessionClient to the engine endpoint the preload bridge hands over
// (Protocol v0 item 2: the first frame is {type: "auth", token}), reconnects
// when the socket closes or the shell announces a new engine, keeps the read
// model in step with the engine (protocol-events-v1.md, "Client read model"),
// fetches peak pyramids from the same engine (Protocol v0 item 23), and mounts
// the React chrome. Under SIANN_SHELL_TEST=1 (the preload's window.siannTest) the
// timeline's test hooks are window.__siannTimeline.

import { createRoot } from 'react-dom/client';

import { App } from './App';
import { PeaksCache } from './model/peaks-cache';
import { SessionClient, type EngineEndpoint, type SocketLike } from './model/session-client';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';

declare global {
  interface Window {
    siann: {
      engine: {
        current(): Promise<EngineEndpoint | null>;
        onChange(callback: (next: EngineEndpoint | null) => void): void;
      };
    };
    // Present only when the shell runs under SIANN_SHELL_TEST=1.
    siannTest?: { timelineHooks?: boolean };
    __siannTimeline?: TimelineTestHooks;
  }
}

const schedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const client = new SessionClient({
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  currentEndpoint: () => window.siann.engine.current(),
  schedule,
  initialStatus: 'connecting',
});

let endpoint: EngineEndpoint | null = null;
const peaks = new PeaksCache({
  fetch: (url, init) => fetch(url, { headers: init.headers, cache: 'no-store' }),
  endpoint: () => endpoint,
  schedule,
});

function connect(next: EngineEndpoint | null): void {
  const changed = next?.port !== endpoint?.port || next?.token !== endpoint?.token;
  endpoint = next;
  client.connect(next);
  if (changed) peaks.endpointChanged();
}

const onTimelineHooks = window.siannTest?.timelineHooks
  ? (hooks: TimelineTestHooks | null) => {
      if (hooks) window.__siannTimeline = hooks;
      else delete window.__siannTimeline;
    }
  : undefined;

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(<App client={client} peaks={peaks} onTimelineHooks={onTimelineHooks} />);

window.siann.engine.onChange(connect);
void window.siann.engine.current().then(connect);
