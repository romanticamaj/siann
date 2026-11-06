// The M0 renderer: connects to the engine's WebSocket with the token the
// preload bridge hands over (Protocol v0 item 2: the first frame is
// {type: "auth", token}), shows the connection state, the session and the
// running build (ADR-0017 point 4, Protocol v0 item 13), and reconnects when
// the socket closes or the shell announces a new engine. Plain TypeScript;
// the UI framework is chosen with M5.

interface EngineEndpoint {
  port: number;
  token: string;
}

interface Window {
  siann: {
    engine: {
      current(): Promise<EngineEndpoint | null>;
      onChange(callback: (next: EngineEndpoint | null) => void): void;
    };
  };
}

interface AboutInfo {
  name?: string;
  version?: string;
  license?: string;
  source?: { url?: string; commit?: string; dirty?: boolean };
}

const RECONNECT_MS = 250;

let socket: WebSocket | null = null;
let active: EngineEndpoint | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function field(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`missing element ${id}`);
  return element;
}

function setStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
  const element = field('status');
  if (element.textContent !== status) element.textContent = status;
}

function showAbout(about: AboutInfo | undefined): void {
  if (!about) return;
  const source = about.source ?? {};
  const commit = source.commit ? source.commit.slice(0, 12) + (source.dirty ? '+dirty' : '') : 'unknown';
  field('about').textContent =
    `${about.name ?? 'siann-engine'} ${about.version ?? ''} (${commit}) · ${about.license ?? ''}` +
    (source.url ? ` · source: ${source.url}` : '');
}

function scheduleReconnect(): void {
  if (retryTimer !== undefined) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void window.siann.engine.current().then((next) => connect(next, true));
  }, RECONNECT_MS);
}

function connect(next: EngineEndpoint | null, force = false): void {
  if (!force && socket && next && active && next.port === active.port && next.token === active.token) return;
  if (retryTimer !== undefined) {
    clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  active = next;
  if (!next) {
    setStatus('disconnected');
    return;
  }
  setStatus('connecting');
  const ws = new WebSocket(`ws://127.0.0.1:${next.port}/`);
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: next.token }));
  ws.onmessage = (event: MessageEvent) => {
    if (socket !== ws || typeof event.data !== 'string') return;
    let message: { type?: string; ok?: boolean; sessionId?: string; revision?: string; about?: AboutInfo };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type !== 'auth') return;
    if (message.ok) {
      field('session-id').textContent = message.sessionId ?? '';
      field('revision').textContent = message.revision ?? '';
      showAbout(message.about);
      setStatus('connected');
    } else {
      setStatus('disconnected');
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    setStatus('disconnected');
    scheduleReconnect();
  };
}

window.siann.engine.onChange((next) => connect(next));
void window.siann.engine.current().then((next) => connect(next));
