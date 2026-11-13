// The engine status chrome: connection state, session, revision and build
// (ADR-0017 point 4, Protocol v0 item 13), plus what the read model holds.
// Reads the session client and the read model through useSyncExternalStore;
// no meter or playhead value passes through React state (ADR-0019 point 3).
// It also holds the language switch (m5-ui-i18n; P1-1 moves it into the
// status bar): each language named in its own script, live, no reload.

import { useSyncExternalStore, type ChangeEvent } from 'react';

import { htmlLang, LOCALE_NAMES, LOCALES, type UserLocale } from './i18n/locale';
import { localeStore, translator, useLocale, type T } from './i18n/t';
import type { ReadModel } from './model/read-model';
import type { AboutInfo, SessionClient } from './model/session-client';

function aboutText(about: AboutInfo | null, t: T): string {
  if (!about) return '';
  const source = about.source ?? {};
  const commit = source.commit ? source.commit.slice(0, 12) + (source.dirty ? '+dirty' : '') : t('about.unknownCommit');
  return (
    `${about.name ?? 'siann-engine'} ${about.version ?? ''} (${commit}) · ${about.license ?? ''}` +
    (source.url ? ` · ${t('about.source', { url: source.url })}` : '')
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
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.getState(),
  );
}

function useSnapshot(model: ReadModel) {
  return useSyncExternalStore(
    (listener) => model.subscribe(listener),
    () => model.getSnapshot(),
  );
}

export function StatusPanel({ client }: { client: SessionClient }) {
  const state = useClientState(client);
  const snapshot = useSnapshot(client.model);
  const t = translator(useLocale());
  const revision = snapshot?.revision ?? state.revision ?? '';
  return (
    <>
      <LocaleSwitch />
      <dl>
        <dt>{t('status.engine')}</dt>
        <dd data-testid="status" data-status={state.status}>
          {t(`connection.${state.status}`)}
        </dd>
        <dt>{t('status.session')}</dt>
        <dd data-testid="session-id">{state.sessionId ?? ''}</dd>
        <dt>{t('status.revision')}</dt>
        <dd data-testid="revision">{revision}</dd>
        <dt>{t('status.tracks')}</dt>
        <dd data-testid="track-count">{snapshot ? String(snapshot.tracks.length) : ''}</dd>
        <dt>{t('status.clips')}</dt>
        <dd data-testid="clip-count">{snapshot ? String(snapshot.clips.length) : ''}</dd>
        <dt>{t('status.syncs')}</dt>
        <dd data-testid="sync-count">{String(state.syncCount)}</dd>
        <dt>{t('status.connections')}</dt>
        <dd data-testid="connections">{String(state.connections)}</dd>
      </dl>
      <footer data-testid="about">{aboutText(state.about, t)}</footer>
    </>
  );
}
