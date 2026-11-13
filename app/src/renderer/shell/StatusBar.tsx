// The status bar (UI redesign spec 2.1): engine connection, the language
// switch (m5-ui-i18n), session, revision, what the read model holds, and the
// about line built only from engine.about and the auth reply (ADR-0017 point
// 4, the source offer of the engine's licence): name, version, commit,
// licence and source, exactly as the engine reports them. No licence is ever
// named in the renderer's source.
// Reads the session client and the read model through useSyncExternalStore;
// no meter or playhead value passes through React state (ADR-0019 point 3).
// The data-testids are those of the former status panel, so the specs that
// read them keep working.

import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from 'react';

import { htmlLang, LOCALE_NAMES, LOCALES, type UserLocale } from '../i18n/locale';
import { localeStore, translator, useLocale, type T } from '../i18n/t';
import type { ReadModel } from '../model/read-model';
import type { AboutInfo, SessionClient } from '../model/session-client';

function shortCommit(about: AboutInfo, t: T): string {
  const source = about.source ?? {};
  return source.commit ? source.commit.slice(0, 12) + (source.dirty ? '+dirty' : '') : t('about.unknownCommit');
}

// The whole line as one string, for the about button's title.
function aboutText(about: AboutInfo, t: T): string {
  const url = about.source?.url;
  const head = `${about.name ?? ''} ${about.version ?? ''} (${shortCommit(about, t)}) · ${about.license ?? ''}`;
  return url ? `${head} · ${t('about.source', { url })}` : head;
}

export function AboutLine({ about }: { about: AboutInfo | null }) {
  const t = translator(useLocale());
  if (!about) return null;
  const source = about.source ?? {};
  const commit = shortCommit(about, t);
  return (
    <>
      <span className="about-name">{about.name ?? ''}</span> <span className="about-version">{about.version ?? ''}</span>{' '}
      (<code className="about-commit">{commit}</code>) · <span className="about-license">{about.license ?? ''}</span>
      {source.url ? (
        <>
          {' · '}
          <span className="about-source">{t('about.source', { url: source.url })}</span>
        </>
      ) : null}
    </>
  );
}

// The licence line in the status bar (spec 2.1: it stays visible or one click
// away, for the source offer of section 13). The licence is its own span at the end and never
// shrinks, so when the bar is short only the rest of the line is cut; the
// button's title is the whole line, and a click opens the About panel.
export function AboutButton({ about, onOpen }: { about: AboutInfo | null; onOpen: () => void }) {
  const t = translator(useLocale());
  if (!about) return <button type="button" className="about" data-testid="about" aria-haspopup="dialog" disabled />;
  const url = about.source?.url;
  return (
    <button
      type="button"
      className="about"
      data-testid="about"
      aria-haspopup="dialog"
      title={aboutText(about, t)}
      onClick={onOpen}
    >
      <span className="about-summary">
        {`${about.name ?? ''} ${about.version ?? ''} (${shortCommit(about, t)})`}
        {url ? ` · ${t('about.source', { url })}` : ''}
      </span>
      <span className="about-sep" aria-hidden="true">
        ·
      </span>
      <span className="about-license">{about.license ?? ''}</span>
    </button>
  );
}

// The About panel: the whole about line, selectable, in a modal dialog. Its
// own keydown handler keeps keys (Escape above all) from the shell's
// dispatcher, whose project-zone Escape would otherwise cancel the close.
export function AboutPanel({ about, open, onClose }: { about: AboutInfo | null; open: boolean; onClose: () => void }) {
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
      <button type="button" data-testid="about-close" onClick={onClose}>
        {t('about.close')}
      </button>
    </dialog>
  );
}

function LocaleSwitch() {
  const locale = useLocale();
  const t = translator(locale);
  const change = (event: ChangeEvent<HTMLSelectElement>) => localeStore().setLocale(event.target.value as UserLocale);
  return (
    <label className="locale-switch">
      {t('locale.label')}{' '}
      <select data-testid="locale-switch" value={locale} onChange={change}>
        {LOCALES.map((option) => (
          <option key={option} value={option} lang={htmlLang(option)}>
            {LOCALE_NAMES[option]}
          </option>
        ))}
      </select>
    </label>
  );
}

function useClientState(client: SessionClient) {
  const get = () => client.getState();
  return useSyncExternalStore((listener) => client.subscribe(listener), get, get);
}

function useSnapshot(model: ReadModel) {
  const get = () => model.getSnapshot();
  return useSyncExternalStore((listener) => model.subscribe(listener), get, get);
}

export function StatusBar({ client }: { client: SessionClient }) {
  const state = useClientState(client);
  const snapshot = useSnapshot(client.model);
  const t = translator(useLocale());
  const [aboutOpen, setAboutOpen] = useState(false);
  const revision = snapshot?.revision ?? state.revision ?? '';
  return (
    <footer className="status-bar" data-testid="status-bar" aria-label={t('status.label')}>
      <dl>
        <dt>{t('status.engine')}</dt>
        <dd data-testid="status" data-status={state.status}>
          {t(`connection.${state.status}`)}
        </dd>
      </dl>
      <LocaleSwitch />
      <dl>
        <dt>{t('status.revision')}</dt>
        <dd data-testid="revision">{revision}</dd>
        <dt>{t('status.session')}</dt>
        <dd data-testid="session-id">{state.sessionId ?? ''}</dd>
        <dt>{t('status.tracks')}</dt>
        <dd data-testid="track-count">{snapshot ? String(snapshot.tracks.length) : ''}</dd>
        <dt>{t('status.clips')}</dt>
        <dd data-testid="clip-count">{snapshot ? String(snapshot.clips.length) : ''}</dd>
        <dt>{t('status.syncs')}</dt>
        <dd data-testid="sync-count">{String(state.syncCount)}</dd>
        <dt>{t('status.connections')}</dt>
        <dd data-testid="connections">{String(state.connections)}</dd>
      </dl>
      <AboutButton about={state.about} onOpen={() => setAboutOpen(true)} />
      <AboutPanel about={state.about} open={aboutOpen && state.about !== null} onClose={() => setAboutOpen(false)} />
    </footer>
  );
}
