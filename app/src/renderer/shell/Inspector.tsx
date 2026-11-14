// The left zone's Inspector, Track tab (UI redesign spec 3.4, 2.1): the
// selected track's name, colour, M, S, volume and pan, drawn with the
// MixConsole strip's own controls (ValueControl, ValueReadout, the same
// toggle) on the same read-model select() of the same track, so the Inspector
// and the strip always agree, a gesture overlay included. The colour is the
// renderer's (timeline/track-colour.ts) and cannot be changed here (no command until
// E-2). It shows the app's selected track (trackId): a track list header
// clicked, or the selected clip's track (m5-ui-arrange). Sections (inserts,
// sends) come in phase 3; by the rule of 3.0 nothing stands in for them.

import { useT } from '../i18n/t';
import { toggleTrack, useTrack } from '../mixer/Strip';
import { ValueControl, ValueReadout } from '../mixer/ValueControl';
import type { GestureController } from '../model/gesture-controller';
import type { SessionClient } from '../model/session-client';
import { trackColourVar } from '../timeline/track-colour';
import { Capable, useCapabilities } from './Capable';

export interface InspectorProps {
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly trackId: string | null;
}

export function Inspector({ client, gestures, trackId }: InspectorProps) {
  const t = useT();
  const can = useCapabilities();
  const track = useTrack(client, trackId);
  if (!track) {
    return (
      <div className="inspector" data-testid="inspector">
        <h2>{t('inspector.label')}</h2>
        <p className="inspector-empty">{t('inspector.noTrack')}</p>
      </div>
    );
  }
  const ref = `track:${track.id}`;
  const gainListed = can.has('gesture.begin') && can.feature('gestures') && can.command('track.set_gain');
  return (
    <div className="inspector" data-testid="inspector">
      <h2>{t('inspector.label')}</h2>
      <div className="inspector-head">
        <span className="inspector-colour" data-testid="inspector-colour" style={{ backgroundColor: `var(${trackColourVar(track.id)})` }} title={t('inspector.colour')} />
        <p className="inspector-track" data-testid="inspector-track">
          {track.name}
        </p>
      </div>
      <div className="inspector-buttons">
        <Capable command="track.set_mute">
          <button type="button" className="ms mute" data-testid="inspector-mute" aria-label={t('strip.muteLabel', { track: track.name })} aria-pressed={track.mute} onClick={() => toggleTrack(client, track, 'track.set_mute')}>
            M
          </button>
        </Capable>
        <Capable command="track.set_solo">
          <button type="button" className="ms solo" data-testid="inspector-solo" aria-label={t('strip.soloLabel', { track: track.name })} aria-pressed={track.solo} onClick={() => toggleTrack(client, track, 'track.set_solo')}>
            S
          </button>
        </Capable>
      </div>
      <div className="inspector-row">
        <span className="inspector-label">{t('inspector.volume')}</span>
        <ValueReadout
          kind="gain"
          entityRef={ref}
          value={track.gainMilliDb}
          gestures={gestures}
          testId="inspector-volume-value"
          label={t('strip.levelLabel', { track: track.name })}
          typing={gainListed ? { testId: 'inspector-volume-input', label: t('strip.gainInput', { track: track.name }) } : undefined}
        />
      </div>
      <Capable method="gesture.begin" feature="gestures" command="track.set_gain">
        <ValueControl
          kind="gain"
          orientation="horizontal"
          entityRef={ref}
          value={track.gainMilliDb}
          gestures={gestures}
          testId="inspector-volume"
          label={t('strip.gainLabel', { track: track.name })}
        />
      </Capable>
      <Capable method="gesture.begin" feature="gestures" command="track.set_pan">
        <div className="inspector-row">
          <span className="inspector-label">{t('strip.pan')}</span>
        </div>
        <ValueControl
          kind="pan"
          orientation="horizontal"
          entityRef={ref}
          value={track.pan}
          gestures={gestures}
          testId="inspector-pan"
          label={t('strip.panLabel', { track: track.name })}
          typing={{ testId: 'inspector-pan-input', label: t('strip.panInput', { track: track.name }) }}
          showText
        />
      </Capable>
    </div>
  );
}
