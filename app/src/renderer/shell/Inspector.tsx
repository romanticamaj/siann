// The left zone's content in phase 1 (UI redesign spec 2.1 and 3.0): the
// selected track's name, nothing more. The Inspector's controls (volume, pan,
// sections) arrive with m5-ui-mixer; by the rule of 3.0 no placeholder stands
// in for them. The selected track is the selected clip's track until the
// track list (m5-ui-arrange) selects tracks itself.

import { useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { SessionClient } from '../model/session-client';

export function Inspector({ client, clipId }: { client: SessionClient; clipId: string | null }) {
  const t = useT();
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
  );
  const clip = clipId ? snapshot?.clips.find((c) => c.id === clipId) : undefined;
  const track = clip ? snapshot?.tracks.find((tr) => tr.id === clip.trackId) : undefined;
  return (
    <div className="inspector" data-testid="inspector">
      <h2>{t('inspector.label')}</h2>
      {track ? (
        <p className="inspector-track" data-testid="inspector-track">
          {track.name}
        </p>
      ) : (
        <p className="inspector-empty">{t('inspector.noTrack')}</p>
      )}
    </div>
  );
}
