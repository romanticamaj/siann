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

import { useSyncExternalStore, type ChangeEvent } from 'react';

import { htmlLang, LOCALE_NAMES, LOCALES, type UserLocale } from '../i18n/locale';
import { localeStore, translator, useLocale } from '../i18n/t';
import type { ReadModel } from '../model/read-model';
import type { AboutInfo, SessionClient } from '../model/session-client';

export function AboutLine({ about }: { about: AboutInfo | null }) {
  const t = translator(useLocale());
  if (!about) return null;
  const source = about.source ?? {};
  const commit = source.commit ? source.commit.slice(0, 12) + (source.dirty ? '+dirty' : '') : t('about.unknownCommit');
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
      <span className="about" data-testid="about">
        <AboutLine about={state.about} />
      </span>
    </footer>
  );
}
