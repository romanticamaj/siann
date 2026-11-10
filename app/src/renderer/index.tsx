// The renderer entry (bundled by scripts/bundle-renderer.js). It connects a
// SessionClient to the engine endpoint the preload bridge hands over
// (Protocol v0 item 2: the first frame is {type: "auth", token}), reconnects
// when the socket closes or the shell announces a new engine, keeps the read
// model in step with the engine (protocol-events-v1.md, "Client read model"),
// opens the realtime channel beside it (meters) and the fader gesture
// controller over it (protocol-gestures-v0.md), and mounts the React chrome.

import { createRoot } from 'react-dom/client';

import { App } from './App';
import { GestureController } from './model/gesture-controller';
import { RealtimeClient, type RealtimeSocket } from './model/realtime-client';
import { SessionClient, type EngineEndpoint, type SocketLike } from './model/session-client';

declare global {
  interface Window {
    siann: {
      engine: {
        current(): Promise<EngineEndpoint | null>;
        onChange(callback: (next: EngineEndpoint | null) => void): void;
      };
    };
    // The gesture controller, for the e2e tests to wait on (settled).
    __siannGestures?: GestureController;
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
const realtime = new RealtimeClient({
  session: client,
  createSocket: (url) => new WebSocket(url) as unknown as RealtimeSocket,
});
const gestures = new GestureController({ client, schedule });
window.__siannGestures = gestures;

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(<App client={client} gestures={gestures} realtime={realtime} />);

window.siann.engine.onChange((next) => client.connect(next));
void window.siann.engine.current().then((next) => client.connect(next));
