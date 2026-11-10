// The engine status chrome: connection state, session, revision and build
// (ADR-0017 point 4, Protocol v0 item 13), plus what the read model holds.
// Reads the session client and the read model through useSyncExternalStore;
// no meter or playhead value passes through React state (ADR-0019 point 3).

import { useSyncExternalStore } from 'react';

import type { ReadModel } from './model/read-model';
import type { AboutInfo, SessionClient } from './model/session-client';

function aboutText(about: AboutInfo | null): string {
  if (!about) return '';
  const source = about.source ?? {};
  const commit = source.commit ? source.commit.slice(0, 12) + (source.dirty ? '+dirty' : '') : 'unknown';
  return (
    `${about.name ?? 'siann-engine'} ${about.version ?? ''} (${commit}) · ${about.license ?? ''}` +
    (source.url ? ` · source: ${source.url}` : '')
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
  const revision = snapshot?.revision ?? state.revision ?? '';
  return (
    <>
      <dl>
        <dt>Engine</dt>
        <dd data-testid="status">{state.status}</dd>
        <dt>Session</dt>
        <dd data-testid="session-id">{state.sessionId ?? ''}</dd>
        <dt>Revision</dt>
        <dd data-testid="revision">{revision}</dd>
        <dt>Tracks</dt>
        <dd data-testid="track-count">{snapshot ? String(snapshot.tracks.length) : ''}</dd>
        <dt>Clips</dt>
        <dd data-testid="clip-count">{snapshot ? String(snapshot.clips.length) : ''}</dd>
        <dt>Syncs</dt>
        <dd data-testid="sync-count">{String(state.syncCount)}</dd>
      </dl>
      <footer data-testid="about">{aboutText(state.about)}</footer>
    </>
  );
}
