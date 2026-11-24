// The status bar (UI redesign spec 2.1), ported from the mockup
// (m5-ui-alignment-chrome; mockup.html, footer.statusbar; docs/harness/
// agent-rules.md, "UI fidelity"): its DOM structure and class names are the
// mockup's, so ui/status-bar.css draws it, in the mockup's words (10.7, 1).
//
//   the engine's connection (i.ok, b), the device segment "type · name · kHz
//   / buffer · latency ms" and the xruns (engine.status, only when
//   engine.capabilities lists it), the side heard (.hear, only when it lists
//   audition.hear), and on the right (.right) the language (.loc, with the
//   language <select> laid over it), the saved revision (the saved mark's
//   baseline, UI redesign UR-4: never an unsaved head), and the about line
//   "name version (commit) · licence · source"
//
// The about line is built only from engine.about and the auth reply
// (ADR-0017 point 4, the source offer of the engine's licence), exactly as
// the engine reports them, with the first 7 characters of the commit; the
// whole commit and the mark of a modified tree are the About panel's. No
// licence is ever named in the renderer's source. It is a button (its
// "source" an <a> without href inside it) that opens the About panel; when
// the bar is short the start of its line clips and the licence stays.
// Reads the session client and the read model through useSyncExternalStore;
// no meter or playhead value passes through React state (ADR-0019 point 3).
// The session id, the head revision and what the read model holds (tracks,
// clips, syncs, connections) are diagnostics, not the bar's content: they sit in the About
// panel, under the data-testids of the former status panel, so the specs that
// read them keep working.

import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent, type ReactNode } from 'react';

import { htmlLang, LOCALE_NAMES, LOCALES, type UserLocale } from '../i18n/locale';
import { localeStore, translator, useLocale, type T } from '../i18n/t';
import { statusFields, type EngineStatusSource } from '../model/engine-status';
import type { PlanStore } from '../model/plan-store';
import type { ReadModel } from '../model/read-model';
import type { AboutInfo, ClientState, ConnectionStatus, SessionClient } from '../model/session-client';
import { useCapabilities } from './Capable';
import { Icon } from './icons';

const SHORT_COMMIT = 7;

// The bar's commit: its first 7 characters.
function shortCommit(about: AboutInfo, t: T): string {
  const commit = about.source?.commit;
  return commit ? commit.slice(0, SHORT_COMMIT) : t('about.unknownCommit');
}

// The About panel's: the whole commit, and +dirty for a modified tree.
function wholeCommit(about: AboutInfo, t: T): string {
  const source = about.source ?? {};
  return source.commit ? source.commit + (source.dirty ? '+dirty' : '') : t('about.unknownCommit');
}

// The whole line as one string, for the about button's title.
function aboutText(about: AboutInfo, t: T): string {
  const url = about.source?.url;
  const head = `${about.name ?? ''} ${about.version ?? ''} (${shortCommit(about, t)}) · ${about.license ?? ''}`;
  return url ? `${head} · ${t('about.source', { url })}` : head;
}

// The About panel's line: name, version, the whole commit, licence, source URL.
export function AboutLine({ about }: { about: AboutInfo | null }) {
  const t = translator(useLocale());
  if (!about) return null;
  const source = about.source ?? {};
  return (
    <>
      <span>{about.name ?? ''}</span> <span>{about.version ?? ''}</span> (<code>{wholeCommit(about, t)}</code>) · <span>{about.license ?? ''}</span>
      {source.url ? (
        <>
          {' · '}
          <span>{t('about.source', { url: source.url })}</span>
        </>
      ) : null}
    </>
  );
}

// The licence line in the status bar (spec 2.1: it stays visible or one
// click away, for the source offer of section 13), as the mockup writes it:
// "siann-engine 0.1.0 (<span class="mono">308d846</span>) · licence · <a>source</a>".
// The licence and the source come after the rest of the line, which alone
// clips when the bar is short; the button's title is the whole line, and a
// click opens the About panel.
export function AboutButton({ about, onOpen }: { about: AboutInfo | null; onOpen: () => void }) {
  const t = translator(useLocale());
  if (!about) return <button type="button" className="about" data-testid="about" aria-haspopup="dialog" disabled />;
  const url = about.source?.url;
  return (
    <button type="button" className="about" data-testid="about" data-part="status-about" aria-haspopup="dialog" title={aboutText(about, t)} onClick={onOpen}>
      <span className="about-summary">
        {`${about.name ?? ''} ${about.version ?? ''} (`}
        <span className="mono" style={{ fontSize: 'var(--fs-micro)' }}>
          {shortCommit(about, t)}
        </span>
      </span>
      <span className="about-tail">
        {') · '}
        <span data-testid="about-license">{about.license ?? ''}</span>
        {url ? (
          <>
            {' · '}
            <a>{t('status.source')}</a>
          </>
        ) : null}
      </span>
    </button>
  );
}

// The About panel: the whole about line, selectable, in a modal dialog. Its
// own keydown handler keeps keys (Escape above all) from the shell's
// dispatcher, whose project-zone Escape would otherwise cancel the close.
export function AboutPanel({
  about,
  open,
  onClose,
  children,
}: {
  about: AboutInfo | null;
  open: boolean;
  onClose: () => void;
  // The diagnostics, below the about line.
  children?: ReactNode;
}) {
  const t = translator(useLocale());
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };
  return (
    <dialog
      ref={ref}
      className="about-panel"
      data-testid="about-panel"
      aria-labelledby="about-panel-title"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <h2 id="about-panel-title">{t('about.title')}</h2>
      <p data-testid="about-panel-line" className="about-panel-line">
        <AboutLine about={about} />
      </p>
      {children}
      <button type="button" data-testid="about-close" onClick={onClose}>
        {t('about.close')}
      </button>
    </dialog>
  );
}

// The language: the mockup's .loc (the globe and the language's own name),
// with the <select> laid over it, transparent, so the box is the mockup's.
function LocaleSwitch() {
  const locale = useLocale();
  const t = translator(locale);
  const change = (event: ChangeEvent<HTMLSelectElement>) => localeStore().setLocale(event.target.value as UserLocale);
  const shown = (LOCALES as readonly string[]).includes(locale) ? LOCALE_NAMES[locale as UserLocale] : LOCALE_NAMES.en;
  return (
    <span className="loc" data-part="status-locale">
      <Icon name="globe" small />
      {shown}
      <select data-testid="locale-switch" aria-label={t('locale.label')} value={locale} onChange={change}>
        {LOCALES.map((option) => (
          <option key={option} value={option} lang={htmlLang(option)}>
            {LOCALE_NAMES[option]}
          </option>
        ))}
      </select>
    </span>
  );
}

// One field of the client's state: the bar re-renders when a field it shows
// changes, not on every event (each advances lastSeq; record.changed comes
// about once a second while recording, UI redesign spec 5.6).
function useClientField<K extends keyof ClientState>(client: SessionClient, key: K): ClientState[K] {
  const get = () => client.getState()[key];
  return useSyncExternalStore((listener) => client.subscribe(listener), get, get);
}

function useSnapshot(model: ReadModel) {
  const get = () => model.getSnapshot();
  return useSyncExternalStore((listener) => model.subscribe(listener), get, get);
}

function useStore<S>(store: { getSnapshot(): S; subscribe(listener: () => void): () => void }): S {
  const get = () => store.getSnapshot();
  return useSyncExternalStore((listener) => store.subscribe(listener), get, get);
}

const ENGINE_WORDS: Readonly<Record<ConnectionStatus, 'status.engineConnecting' | 'status.engineConnected' | 'status.engineDisconnected'>> = {
  connecting: 'status.engineConnecting',
  connected: 'status.engineConnected',
  disconnected: 'status.engineDisconnected',
};

// The saved mark's baseline (model/project.ts SavedMark): the revision last
// saved, or synced first; null before that.
export interface SavedRevisionSource {
  savedRevision(): string | null;
  subscribe(listener: () => void): () => void;
}

const NO_SAVED: SavedRevisionSource = { savedRevision: () => null, subscribe: () => () => undefined };

export interface StatusBarProps {
  readonly client: SessionClient;
  readonly plans: PlanStore;
  readonly engineStatus: EngineStatusSource;
  // Without one (a test's bar) no revision is called saved.
  readonly saved?: SavedRevisionSource;
}

export function StatusBar({ client, plans, engineStatus, saved = NO_SAVED }: StatusBarProps) {
  const state = {
    status: useClientField(client, 'status'),
    revision: useClientField(client, 'revision'),
    about: useClientField(client, 'about'),
    sessionId: useClientField(client, 'sessionId'),
    syncCount: useClientField(client, 'syncCount'),
    connections: useClientField(client, 'connections'),
  };
  const snapshot = useSnapshot(client.model);
  const status = useStore(engineStatus);
  const heard = useStore(plans).heard;
  const can = useCapabilities();
  const t = translator(useLocale());
  const [aboutOpen, setAboutOpen] = useState(false);
  // The head, a diagnostic; the bar's "Saved · rN" is the saved mark's baseline (UR-4).
  const revision = snapshot?.revision ?? state.revision ?? '';
  const savedRevision = useSyncExternalStore(saved.subscribe, saved.savedRevision, saved.savedRevision) ?? '';
  const fields = status ? statusFields(status, t) : null;
  return (
    <footer className="statusbar" data-region="status-bar" data-testid="status-bar" aria-label={t('status.label')}>
      <span data-part="status-engine" data-testid="status" data-status={state.status}>
        <i className="ok" />
        <b>{t(ENGINE_WORDS[state.status])}</b>
      </span>
      {fields && can.has('engine.status') ? (
        <>
          <span data-part="status-device" data-testid="device" title={fields.type ? `${fields.type}/${fields.name}` : fields.name}>
            {/* One text node, as the mockup's, so the run shapes the same. */}
            {`${fields.type ? `${fields.type} · ` : ''}${fields.name}${fields.rate ? ' · ' : ''}`}
            {fields.rate ? (
              <>
                <b className="num">{fields.rate}</b>
                {' / '}
                <b className="num">{fields.buffer}</b>
                {' · '}
                <span className="num" data-testid="latency">
                  {fields.latency}
                </span>
              </>
            ) : null}
          </span>
          <span data-part="status-xruns">
            <b className="num" data-testid="xruns">
              {fields.xruns}
            </b>{' '}
            {t('status.xrunsUnit')}
          </span>
        </>
      ) : null}
      {heard !== null && can.has('audition.hear') ? (
        <span className="hear" data-part="status-hearing">
          <Icon name="phones" small />
          {t('status.hearing')}{' '}
          <b data-testid="status-heard" data-heard={heard === 'main' ? 'main' : 'proposal'}>
            {t(heard === 'main' ? 'status.hearMain' : 'status.hearProposal')}
          </b>
        </span>
      ) : null}
      <span className="right">
        <LocaleSwitch />
        <span data-part="status-saved">
          {`${t('status.saved')} · `}
          <b className="num" data-testid="saved-revision">
            {savedRevision}
          </b>
        </span>
        <AboutButton about={state.about} onOpen={() => setAboutOpen(true)} />
      </span>
      <AboutPanel about={state.about} open={aboutOpen && state.about !== null} onClose={() => setAboutOpen(false)}>
        <h3>{t('about.diagnostics')}</h3>
        <dl className="about-diagnostics">
          <dt>{t('status.session')}</dt>
          <dd data-testid="session-id">{state.sessionId ?? ''}</dd>
          <dt>{t('status.head')}</dt>
          <dd data-testid="revision">{revision}</dd>
          <dt>{t('status.tracks')}</dt>
          <dd data-testid="about-track-count">{snapshot ? String(snapshot.tracks.length) : ''}</dd>
          <dt>{t('status.clips')}</dt>
          <dd data-testid="clip-count">{snapshot ? String(snapshot.clips.length) : ''}</dd>
          <dt>{t('status.syncs')}</dt>
          <dd data-testid="sync-count">{String(state.syncCount)}</dd>
          <dt>{t('status.connections')}</dt>
          <dd data-testid="connections">{String(state.connections)}</dd>
        </dl>
      </AboutPanel>
    </footer>
  );
}
