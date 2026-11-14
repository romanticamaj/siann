// One MixConsole strip (UI redesign spec 3.4, Cubase's order top to bottom):
// pan, M and S, the fader beside its meter slot, the level and peak values,
// and the name on the track colour. The fader and the pan are ValueControls
// (gestures through the GestureController, one revision each); mute and solo
// commit through command.execute and show only what the engine committed.
// The meter slot and the peak value are empty elements the Mixer's one meter
// canvas measures and writes (MixerMeters); no meter value passes through
// React. The strip re-renders only when its track (with any gesture overlay)
// changes: it reads the read model's select() for its ref.
//
// The capability rule (spec 3.0): the fader and the pan exist only when
// engine.capabilities lists the gesture methods and feature and the command
// the gesture ends in (track.set_gain, track.set_pan); mute and solo only
// when it lists track.set_mute and track.set_solo. The level value always
// reads; it takes a typed value only when the fader exists.

import { memo, useContext, useEffect, useRef, useSyncExternalStore } from 'react';

import { useT } from '../i18n/t';
import type { TrackEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { SessionClient } from '../model/session-client';
import { Capable, useCapabilities } from '../shell/Capable';
import { trackColourVar } from '../timeline/track-colour';
import { MetersContext } from './meters-context';
import { ValueControl, ValueReadout } from './ValueControl';

export interface StripProps {
  readonly trackId: string;
  readonly client: SessionClient;
  readonly gestures: GestureController;
}

// The track as the UI shows it (committed, or with the gesture's overlay).
export function useTrack(client: SessionClient, trackId: string | null): TrackEntity | undefined {
  const ref = trackId ? `track:${trackId}` : null;
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => (ref ? (client.model.select(ref) as TrackEntity | undefined) : undefined),
    () => (ref ? (client.model.select(ref) as TrackEntity | undefined) : undefined),
  );
}

// Mute or solo, flipped from what the engine committed.
export function toggleTrack(client: SessionClient, track: TrackEntity, op: 'track.set_mute' | 'track.set_solo'): void {
  const field = op === 'track.set_mute' ? 'mute' : 'solo';
  const revision = client.model.getSnapshot()?.revision;
  void client.execute([{ op, trackId: track.id, [field]: !track[field] }], revision).catch(() => undefined);
}

// The meter slot of `ref`: an empty well the Mixer's meter canvas measures
// and paints while it is mounted.
export function MeterSlot({ meterRef, testId }: { meterRef: string; testId: string }) {
  const meters = useContext(MetersContext);
  const slot = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!meters || !slot.current) return undefined;
    return meters.slot(meterRef, slot.current);
  }, [meters, meterRef]);
  return <div ref={slot} className="meter-slot" data-testid={testId} data-part-of="meter" />;
}

// The peak value of `ref`: its text (and clip class) is written by the meter
// canvas; a click resets the hold, the peak and the clip.
export function PeakValue({ meterRef, testId, label }: { meterRef: string; testId: string; label: string }) {
  const meters = useContext(MetersContext);
  const peak = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!meters || !peak.current) return undefined;
    return meters.peak(meterRef, peak.current);
  }, [meters, meterRef]);
  return <button type="button" ref={peak} className="peak-value" data-testid={testId} aria-label={label} onClick={() => meters?.reset(meterRef)} />;
}

export const Strip = memo(function Strip({ trackId, client, gestures }: StripProps) {
  const t = useT();
  const can = useCapabilities();
  const track = useTrack(client, trackId);
  if (!track) return null;
  const ref = `track:${trackId}`;
  const colour = `var(${trackColourVar(trackId)})`;
  const faderListed = can.has('gesture.begin') && can.feature('gestures') && can.command('track.set_gain');
  return (
    <section className="strip" data-testid={`mixer-strip-${trackId}`} data-part-item="strip" aria-label={track.name}>
      <div className="strip-pan" data-part-of="pan">
        <Capable method="gesture.begin" feature="gestures" command="track.set_pan">
          <ValueControl
            kind="pan"
            orientation="horizontal"
            entityRef={ref}
            value={track.pan}
            gestures={gestures}
            testId={`pan-${trackId}`}
            label={t('strip.panLabel', { track: track.name })}
            typing={{ testId: `pan-input-${trackId}`, label: t('strip.panInput', { track: track.name }) }}
            showText
          />
        </Capable>
      </div>
      <div className="strip-buttons" data-part-of="buttons">
        <Capable command="track.set_mute">
          <button type="button" className="ms mute" data-testid={`mute-${trackId}`} data-part-of="mute" aria-label={t('strip.muteLabel', { track: track.name })} aria-pressed={track.mute} onClick={() => toggleTrack(client, track, 'track.set_mute')}>
            M
          </button>
        </Capable>
        <Capable command="track.set_solo">
          <button type="button" className="ms solo" data-testid={`solo-${trackId}`} data-part-of="solo" aria-label={t('strip.soloLabel', { track: track.name })} aria-pressed={track.solo} onClick={() => toggleTrack(client, track, 'track.set_solo')}>
            S
          </button>
        </Capable>
      </div>
      <div className="strip-fader" data-part-of="fader-area">
        <Capable method="gesture.begin" feature="gestures" command="track.set_gain">
          <ValueControl
            kind="gain"
            orientation="vertical"
            entityRef={ref}
            value={track.gainMilliDb}
            gestures={gestures}
            testId={`fader-${trackId}`}
            label={t('strip.gainLabel', { track: track.name })}
          />
        </Capable>
        <MeterSlot meterRef={ref} testId={`meter-${trackId}`} />
      </div>
      <div className="strip-values" data-part-of="readout">
        <ValueReadout
          kind="gain"
          entityRef={ref}
          value={track.gainMilliDb}
          gestures={gestures}
          testId={`fader-value-${trackId}`}
          label={t('strip.levelLabel', { track: track.name })}
          typing={faderListed ? { testId: `gain-input-${trackId}`, label: t('strip.gainInput', { track: track.name }) } : undefined}
        />
        <PeakValue meterRef={ref} testId={`peak-value-${trackId}`} label={t('strip.peakLabel', { track: track.name })} />
      </div>
      <div className="strip-name" data-testid={`strip-name-${trackId}`} data-part-of="name" style={{ backgroundColor: colour }} title={track.name}>
        {track.name}
      </div>
    </section>
  );
});

// The meter-only master strip (spec 3.0: the master fader waits for E-11).
export function MasterStrip() {
  const t = useT();
  return (
    <section className="strip strip-master" data-testid="mixer-strip-master" data-part-item="strip" data-part-key="master" aria-label={t('strip.master')}>
      <div className="strip-fader" data-part-of="fader-area">
        <MeterSlot meterRef="master" testId="meter-master" />
      </div>
      <div className="strip-values" data-part-of="readout">
        <PeakValue meterRef="master" testId="peak-value-master" label={t('strip.peakLabel', { track: t('strip.master') })} />
      </div>
      <div className="strip-name strip-name-master" data-part-of="name">{t('strip.master')}</div>
    </section>
  );
}
