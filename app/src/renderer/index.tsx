// The renderer entry (bundled by scripts/bundle-renderer.js). It connects a
// SessionClient to the engine endpoint the preload bridge hands over
// (Protocol v0 item 2: the first frame is {type: "auth", token}), reconnects
// when the socket closes or the shell announces a new engine, keeps the read
// model in step with the engine (protocol-events-v1.md, "Client read model"),
// opens the realtime channel beside it (meters) and the fader gesture
// controller over it (protocol-gestures-v0.md), fetches peak pyramids from the
// same engine (Protocol v0 item 23), mirrors the engine's plans for plan
// review (Protocol v0 item 25), and mounts the React chrome. The UI locale
// (m5-ui-i18n) follows navigator.languages, or a stored manual choice, and
// sets <html lang> on start and on every switch. The zone layout
// (m5-ui-shell) is read from and kept in localStorage (siann.layout.v1), and
// the key commands' registry is made here for the shell and the zones. The
// connection phase and the toast store (m5-ui-connection) are made here too:
// each reconnect pushes a toast naming the recovered revision.
//
// This is the only renderer file that names the shell's preload bridge
// (UI redesign spec 5.8): in a plain browser tab it is absent and the
// renderer stays disconnected. Under SIANN_SHELL_TEST=1
// (the preload's window.siannTest) the timeline's test hooks are
// window.__siannTimeline, the locale store is window.__siannLocale (which
// accepts the pseudo-locale), and window.siannTest.languages, when the test
// pinned them, stands in for navigator.languages; window.__siannClient hands
// the e2e tests the session client's log of requests refused as disconnected.

import { createRoot } from 'react-dom/client';

import { App } from './App';
import { CommandRegistry } from './keys/commands';
import { platformOf } from './keys/dispatcher';
import { createLocaleStore, htmlLang, type LocaleStorage, type LocaleStore } from './i18n/locale';
import { reconnectedMessage } from './i18n/messages';
import { installLocaleStore } from './i18n/t';
import { ConnectionPhaseStore } from './model/connection-phase';
import { EngineStatusStore } from './model/engine-status';
import { GestureController } from './model/gesture-controller';
import { PeaksCache } from './model/peaks-cache';
import { PlanStore } from './model/plan-store';
import { RealtimeClient, type RealtimeSocket } from './model/realtime-client';
import { SessionClient, type EngineEndpoint, type SocketLike } from './model/session-client';
import { createLayoutStore } from './shell/layout-store';
import { announceReconnects, ToastStore } from './shell/toast-store';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';

declare global {
  interface Window {
    // The preload bridge; absent in a plain browser tab.
    siann?: {
      engine: {
        current(): Promise<EngineEndpoint | null>;
        onChange(callback: (next: EngineEndpoint | null) => void): void;
      };
    };
    // The gesture controller, for the e2e tests to wait on (settled).
    __siannGestures?: GestureController;
    // Present only when the shell runs under SIANN_SHELL_TEST=1.
    siannTest?: { timelineHooks?: boolean; languages?: readonly string[] };
    __siannTimeline?: TimelineTestHooks;
    __siannLocale?: LocaleStore;
    __siannClient?: { refused(): ReadonlyArray<{ readonly method: string }> };
  }
}

function localStorageOrNull(): LocaleStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const locales = createLocaleStore({
  languages: window.siannTest?.languages ?? navigator.languages,
  storage: localStorageOrNull(),
  allowPseudo: window.siannTest !== undefined,
});
installLocaleStore(locales);
const applyLocale = () => {
  const locale = locales.getSnapshot();
  document.documentElement.lang = htmlLang(locale);
  document.documentElement.dataset.locale = locale;
};
applyLocale();
locales.subscribe(applyLocale);
if (window.siannTest) window.__siannLocale = locales;

const schedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const bridge = window.siann;
const testHooks = window.siannTest;

const client = new SessionClient({
  createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
  currentEndpoint: () => (bridge ? bridge.engine.current() : Promise.resolve(null)),
  schedule,
  initialStatus: bridge ? 'connecting' : 'disconnected',
});
const realtime = new RealtimeClient({
  session: client,
  createSocket: (url) => new WebSocket(url) as unknown as RealtimeSocket,
});
const gestures = new GestureController({ client, schedule });
window.__siannGestures = gestures;
const plans = new PlanStore();
plans.attach(client);
const engineStatus = new EngineStatusStore({ client, schedule });
if (testHooks) window.__siannClient = { refused: () => client.refused() };

const connection = new ConnectionPhaseStore(client, { schedule });
const toasts = new ToastStore({ schedule });
announceReconnects(connection, toasts, (revision) => reconnectedMessage(locales.getSnapshot(), { revision }));

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

const layout = createLayoutStore({ storage: localStorageOrNull() });
const commands = new CommandRegistry();

const onTimelineHooks = testHooks?.timelineHooks
  ? (hooks: TimelineTestHooks | null) => {
      if (hooks) window.__siannTimeline = hooks;
      else delete window.__siannTimeline;
    }
  : undefined;

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(
  <App
    client={client}
    gestures={gestures}
    realtime={realtime}
    peaks={peaks}
    plans={plans}
    engineStatus={engineStatus}
    layout={layout}
    commands={commands}
    platform={platformOf(navigator.platform)}
    connection={connection}
    toasts={toasts}
    onTimelineHooks={onTimelineHooks}
  />,
);

if (bridge) {
  // The shell announces no endpoint only after an engine went away (a failed
  // launch, a crash, giving up): that ends a start without the banner.
  bridge.engine.onChange((next) => {
    connect(next);
    if (next === null) connection.engineDown();
  });
  void bridge.engine.current().then(connect);
}
