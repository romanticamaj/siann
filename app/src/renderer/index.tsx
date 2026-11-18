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
// window.__siannTimeline, the mixer's meter canvas is window.__siannMeters,
// the plan review's ghosts are window.__siannGhosts (m5b-ui-ghosts),
// the locale store is window.__siannLocale (which accepts the pseudo-locale),
// window.siannTest.languages, when the test pinned them, stands in for
// navigator.languages, window.__siannClient hands the e2e tests the session
// client's log of requests refused as disconnected, of requests sent and of
// the engine's answers, window.siannTest.capabilities, when the test gave
// SIANN_TEST_CAPABILITIES, is the engine.capabilities answer the session
// client uses instead of the engine's (m5-ui-loop-click),
// window.siannTest.environment, when the fidelity run gave
// SIANN_FIDELITY_ENVIRONMENT, is the device and build the session client
// answers in place of the engine's (m5-ui-alignment-chrome), and
// a <Profiler> at the
// root counts React commits in window.__siannCommits, and each <Counted id>
// (shell/Counted.tsx) those under it in window.__siannCommitsBy[id]. Only the profiling
// bundle (renderer.profiling.js, served under SIANN_SHELL_PROFILING=1) calls
// onRender; in the production bundle the count stays absent (UI redesign
// spec 5.6).
//
// Projects (m5b-ui-project): the bridge's project half (the shell's record of
// bundles, its folder dialogs and the report of a bundle the engine opened)
// becomes the ProjectController's ShellPort here, and its menu half carries
// the application menu's model (shell/app-menu.ts), sent again on every
// locale, capability or recent-list change, and the command ids of the
// clicks, run through the CommandRegistry. In a plain tab both are absent,
// and so are New, Open and the recent list. The window title is the
// session's name, the saved mark after it while the head is newer than the
// last save, and the app's name.

import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { COMMAND_IDS, CommandRegistry, type CommandId } from './keys/commands';
import { platformOf } from './keys/dispatcher';
import { createLocaleStore, htmlLang, type LocaleStorage, type LocaleStore } from './i18n/locale';
import { reconnectedMessage } from './i18n/messages';
import { installLocaleStore, translator } from './i18n/t';
import { ConnectionPhaseStore } from './model/connection-phase';
import { EngineStatusStore } from './model/engine-status';
import { GestureController } from './model/gesture-controller';
import { PeaksCache } from './model/peaks-cache';
import { BranchSnapshotStore } from './model/branch-snapshot';
import { AgentStore } from './model/agents';
import { PlanStore } from './model/plan-store';
import { ReviewStore } from './model/review-store';
import type { Ghost } from './plans/ghosts';
import { RealtimeClient, type RealtimeSocket } from './model/realtime-client';
import { UndoHistory } from './model/undo-history';
import { SessionClient, type AnsweredRequest, type EngineEndpoint, type SentRequest, type SocketLike, type TestEnvironment } from './model/session-client';
import { LoopClickController, TransportStateStore, clientCapabilities } from './model/loop-click';
import { capabilitySelector, type Capabilities } from './model/capabilities';
import { ProjectController, SavedMark, type ShellPort, type ShellProjectState } from './model/project';
import { StudioSetupController } from './model/studio-setup';
import { appMenuModel, type MenuModel } from './shell/app-menu';
import { TransportController } from './model/transport';
import { createLayoutStore } from './shell/layout-store';
import { announceReconnects, ToastStore } from './shell/toast-store';
import { setCommitSink } from './shell/Counted';
import { displayWrites, transportEnabled } from './shell/Transport';
import type { MeterTestHooks } from './mixer/MixerMeters';
import { PickerController } from './mixer/picker';
import { PluginActions } from './model/plugin-actions';
import { createFrameRecorder, installFrameMarks, readyLineAt, type FrameTestHooks } from './perf/frame-marks';
import type { TimelineTestHooks } from './timeline/TimelineCanvas';

declare global {
  interface Window {
    // The preload bridge; absent in a plain browser tab.
    siann?: {
      engine: {
        current(): Promise<EngineEndpoint | null>;
        onChange(callback: (next: EngineEndpoint | null) => void): void;
      };
      // The shell's record of bundles and its folder dialogs (m5b-ui-project).
      project?: {
        state(): Promise<ShellProjectState | null>;
        chooseNew(): Promise<string | null>;
        chooseOpen(): Promise<string | null>;
        opened(path: string): void;
        onChange(callback: (state: ShellProjectState) => void): void;
      };
      // The application menu (m5b-ui-project): its model out, its clicks in.
      menu?: {
        set(model: MenuModel): void;
        onCommand(callback: (command: string) => void): void;
      };
    };
    // The gesture controller, for the e2e tests to wait on (settled).
    __siannGestures?: GestureController;
    // Present only when the shell runs under SIANN_SHELL_TEST=1.
    siannTest?: {
      timelineHooks?: boolean;
      engineReadyAt?: () => Promise<number | null>;
      languages?: readonly string[];
      capabilities?: Capabilities;
      environment?: TestEnvironment;
    };
    __siannTimeline?: TimelineTestHooks;
    __siannLocale?: LocaleStore;
    // The toast store, for the fit test to raise a toast per locale.
    __siannToasts?: ToastStore;
    // The position display's write count (m5-ui-transport display-rate e2e)
    // and the newest realtime frame's playhead, unextrapolated (null without one).
    __siannTransport?: { displayWrites(): number; playhead(): string | null };
    __siannClient?: {
      refused(): ReadonlyArray<{ readonly method: string }>;
      sent(): ReadonlyArray<SentRequest>;
      answered(): ReadonlyArray<AnsweredRequest>;
    };
    __siannMeters?: MeterTestHooks;
    // The plan review's ghosts as the window draws them (m5b-ui-ghosts).
    __siannGhosts?: { list(): readonly Ghost[]; ticked(): number[] | null; outline(): number | null };
    // The frame marks' recorder (perf scenario, test hook only).
    __siannFrames?: FrameTestHooks;
    // React commits counted at the root (profiling bundle only).
    __siannCommits?: number;
    // React commits under each <Counted id> (profiling bundle only).
    __siannCommitsBy?: Record<string, number>;
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
  ...(testHooks?.capabilities ? { capabilities: testHooks.capabilities } : {}),
  ...(testHooks?.environment ? { environment: testHooks.environment } : {}),
});
const realtime = new RealtimeClient({
  session: client,
  createSocket: (url) => new WebSocket(url) as unknown as RealtimeSocket,
});
const gestures = new GestureController({ client, schedule });
window.__siannGestures = gestures;
const plans = new PlanStore();
plans.attach(client);
// The proposals' branch snapshots (m5b-ui-audition): the ghosts of a heard proposal are drawn solid from them.
const branches = new BranchSnapshotStore();
branches.attach(client);
// The agents the engine lists (m5b-ui-plan-metadata): engine.status, then agent.changed.
const agents = new AgentStore();
agents.attach(client);
// The plan under review, its preview and its ghosts (m5b-ui-ghosts).
const review = new ReviewStore({ client, plans, branches });
if (testHooks) {
  window.__siannGhosts = {
    list: () => review.ghosts(),
    ticked: () => {
      const ticked = review.getSnapshot().ticked;
      return ticked === null ? null : [...ticked].sort((a, b) => a - b);
    },
    outline: () => review.outlineStep(),
  };
}
const engineStatus = new EngineStatusStore({ client, schedule });
if (testHooks) window.__siannClient = { refused: () => client.refused(), sent: () => client.sent(), answered: () => client.answered() };

const connection = new ConnectionPhaseStore(client, { schedule });
const toasts = new ToastStore({ schedule });
if (testHooks) window.__siannToasts = toasts;
announceReconnects(connection, toasts, (revision) => reconnectedMessage(locales.getSnapshot(), { revision }));
if (testHooks) window.__siannTransport = { displayWrites, playhead: () => realtime.playhead()?.playheadSamples ?? null };
// What undo and redo can do now (the top bar dims what cannot).
const history = new UndoHistory(client);
const transport = new TransportController({
  client,
  playing: () => realtime.playhead()?.playing ?? false,
  toasts,
  locale: () => locales.getSnapshot(),
  onNothingLeft: (method) => history.refused(method),
});
const transportState = new TransportStateStore(client);
const loopClick = new LoopClickController({
  client,
  model: client.model,
  state: transportState,
  deviceReady: () => transportEnabled(engineStatus.getSnapshot(), client.getState().status === 'connected'),
  capabilities: clientCapabilities(client),
  toasts,
  locale: () => locales.getSnapshot(),
});

// The insert racks (m5b-ui-inserts-master): the plugin methods, the picker an empty slot opens, and engine.status for each slot's state.
const pluginActions = new PluginActions({ client, toasts, locale: () => locales.getSnapshot() });
const inserts = { actions: pluginActions, picker: new PickerController({ actions: pluginActions }), status: engineStatus };

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

// Projects and Studio Setup (m5b-ui-project).
const projectBridge = bridge?.project;
const EMPTY_PROJECTS: ShellProjectState = { current: null, startView: false, recent: [] };
const shellPort: ShellPort | null = projectBridge
  ? {
      state: async () => (await projectBridge.state()) ?? EMPTY_PROJECTS,
      chooseNew: () => projectBridge.chooseNew(),
      chooseOpen: () => projectBridge.chooseOpen(),
      opened: (path) => projectBridge.opened(path),
      onChange: (listener) => projectBridge.onChange(listener),
    }
  : null;
const saved = new SavedMark(client);
const project = new ProjectController({ client, shell: shellPort, locale: () => locales.getSnapshot(), toasts, saved });
void project.start();
const studioSetup = new StudioSetupController({ client, status: engineStatus, locale: () => locales.getSnapshot() });

const menuBridge = bridge?.menu;
if (menuBridge) {
  let sentMenu = '';
  const pushMenu = () => {
    const model = appMenuModel({
      t: translator(locales.getSnapshot()),
      recent: project.getSnapshot().recent,
      shell: shellPort !== null,
      can: capabilitySelector(client.getState().capabilities),
    });
    const text = JSON.stringify(model);
    if (text === sentMenu) return;
    sentMenu = text;
    menuBridge.set(model);
  };
  locales.subscribe(pushMenu);
  project.subscribe(pushMenu);
  client.subscribe(pushMenu);
  pushMenu();
  menuBridge.onCommand((command) => {
    if ((COMMAND_IDS as readonly string[]).includes(command)) commands.run('window', command as CommandId);
  });
}

// The window title: the session's name, the saved mark, the app's name.
const updateTitle = () => {
  const t = translator(locales.getSnapshot());
  const view = project.getSnapshot();
  const name = view.shell && view.startView ? '' : (client.model.getSnapshot()?.root?.name ?? '');
  const mark = saved.getSnapshot() ? ` ${t('session.unsavedMark')}` : '';
  const title = name ? `${name}${mark} - ${t('app.title')}` : t('app.title');
  if (document.title !== title) document.title = title;
};
for (const source of [locales, project, saved, client.model]) source.subscribe(updateTitle);
updateTitle();

const onTimelineHooks = testHooks?.timelineHooks
  ? (hooks: TimelineTestHooks | null) => {
      if (hooks) window.__siannTimeline = hooks;
      else delete window.__siannTimeline;
    }
  : undefined;

const onMeterHooks = testHooks
  ? (hooks: MeterTestHooks | null) => {
      if (hooks) window.__siannMeters = hooks;
      else delete window.__siannMeters;
    }
  : undefined;

// The perf scenario's frame marks (m5b-nightly-quality; UI redesign 5.6): only
// under the test hook; otherwise the draw paths' marks stay a no-op.
// The cold start runs from the engine's ready line, which the main process
// read (window.siannTest.engineReadyAt), not from the client's first
// authenticated connection: that comes after the endpoint's IPC, the
// WebSocket connect and the token handshake, all inside the budget. The
// connection only says that a painted session is this engine's.
const frames = createFrameRecorder(testHooks, {
  perf: performance,
  frameTime: () => {
    const time = document.timeline?.currentTime;
    return typeof time === 'number' ? time : null;
  },
});
if (frames) {
  installFrameMarks(frames);
  window.__siannFrames = { samples: () => frames.samples(), clear: () => frames.clear(), coldStartMs: () => frames.coldStartMs() };
  let asked = false;
  const ready = () => {
    if (client.getState().status !== 'connected') return;
    frames.connected();
    // The ready line precedes the first connection, so its time is known now.
    if (asked || !testHooks?.engineReadyAt) return;
    asked = true;
    void testHooks.engineReadyAt().then((at) => {
      const start = readyLineAt(at, performance.timeOrigin);
      if (start !== null) frames.engineReadyAt(start);
    });
  };
  client.subscribe(ready);
  ready();
}

const countCommit = () => {
  window.__siannCommits = (window.__siannCommits ?? 0) + 1;
};
if (testHooks) {
  setCommitSink((id) => {
    const counts = (window.__siannCommitsBy ??= {});
    counts[id] = (counts[id] ?? 0) + 1;
  });
}

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
const app = (
  <App
    client={client}
    gestures={gestures}
    realtime={realtime}
    peaks={peaks}
    plans={plans}
    agents={agents}
    review={review}
    engineStatus={engineStatus}
    layout={layout}
    commands={commands}
    platform={platformOf(navigator.platform)}
    connection={connection}
    toasts={toasts}
    transport={transport}
    loopClick={loopClick}
    history={history}
    onTimelineHooks={onTimelineHooks}
    onMeterHooks={onMeterHooks}
    project={project}
    saved={saved}
    studioSetup={studioSetup}
    inserts={inserts}
  />
);
createRoot(container).render(
  testHooks ? (
    <Profiler id="root" onRender={countCommit}>
      {app}
    </Profiler>
  ) : (
    app
  ),
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
