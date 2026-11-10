// The renderer entry (bundled by scripts/bundle-renderer.js). It connects a
// SessionClient to the engine endpoint the preload bridge hands over
// (Protocol v0 item 2: the first frame is {type: "auth", token}), reconnects
// when the socket closes or the shell announces a new engine, keeps the read
// model in step with the engine (protocol-events-v1.md, "Client read model"),
// and mounts the React chrome.

import { createRoot } from 'react-dom/client';

import { App } from './App';
import { SessionClient, type EngineEndpoint, type SocketLike } from './model/session-client';

declare global {
  interface Window {
    siann: {
      engine: {
        current(): Promise<EngineEndpoint | null>;
        onChange(callback: (next: EngineEndpoint | null) => void): void;
      };
    };
  }
}

const client = new SessionClient({
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  currentEndpoint: () => window.siann.engine.current(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  initialStatus: 'connecting',
});

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(<App client={client} />);

window.siann.engine.onChange((next) => client.connect(next));
void window.siann.engine.current().then((next) => client.connect(next));
