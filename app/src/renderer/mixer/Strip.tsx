// One mixer strip (m5-mixer): a fader for the track's gain, a pan control,
// mute and solo buttons and a meter. The fader and pan are continuous
// gestures (protocol-gestures-v0.md): a pointer drag is one gesture through
// the GestureController, whose overlay the strip shows through
// ReadModel.select; a keyboard step is a gesture of one move. Mute and solo
// commit through command.execute and show only what the engine committed.
// The meter is a MeterCanvas the strip mounts; its values never pass through
// React (ADR-0019 point 3).

import { useEffect, useRef, useSyncExternalStore, type ChangeEvent } from 'react';

import { useT } from '../i18n/t';
import type { TrackEntity } from '../model/document';
import type { GestureController } from '../model/gesture-controller';
import type { GestureField } from '../model/read-model';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { MeterCanvas } from './MeterCanvas';

export const FADER_MIN_MILLI_DB = -60_000;
export const FADER_MAX_MILLI_DB = 12_000;
const PAN_RANGE = 10_000;

export interface StripProps {
  readonly trackId: string;
  readonly client: SessionClient;
  readonly gestures: GestureController;
  readonly realtime: RealtimeClient;
}

function faderValue(gainMilliDb: number): number {
  return Math.min(FADER_MAX_MILLI_DB, Math.max(FADER_MIN_MILLI_DB, gainMilliDb));
}

function useView(client: SessionClient) {
  return useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getView(),
  );
}

export function Strip({ trackId, client, gestures, realtime }: StripProps) {
  const view = useView(client);
  const t = useT();
  const ref = `track:${trackId}`;
  const track = client.model.select(ref) as TrackEntity | undefined;
  // The field a pointer drag holds right now (a ref: no re-render per drag).
  const dragging = useRef<GestureField | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const present = track !== undefined;

  useEffect(() => {
    if (!present || !canvas.current) return undefined;
    const meter = new MeterCanvas(canvas.current, realtime, ref);
    meter.start();
    return () => meter.stop();
  }, [realtime, ref, present]);

  if (!track) return null;

  // False when the read model refuses the gesture (another one is held).
  const begin = (field: GestureField): boolean => {
    try {
      gestures.begin(ref, field);
      return true;
    } catch {
      return false;
    }
  };

  const press = (field: GestureField) => {
    if (dragging.current) return;
    if (!begin(field)) return;
    dragging.current = field;
    const release = () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      if (dragging.current !== field) return;
      dragging.current = null;
      gestures.end();
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  };

  const change = (field: GestureField) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    if (dragging.current === field) {
      gestures.move(value);
      return;
    }
    // A keyboard step: one gesture of one move.
    if (!begin(field)) return;
    gestures.move(value);
    gestures.end();
  };

  const toggle = (op: 'track.set_mute' | 'track.set_solo') => {
    const field = op === 'track.set_mute' ? 'mute' : 'solo';
    const revision = view.snapshot?.revision;
    void client.execute([{ op, trackId, [field]: !track[field] }], revision).catch(() => undefined);
  };

  const gain = faderValue(track.gainMilliDb);
  return (
    <section className="strip" data-testid={`mixer-strip-${trackId}`}>
      <header className="strip-name">{track.name}</header>
      <canvas className="strip-meter" data-testid={`meter-${trackId}`} width={24} height={120} ref={canvas} />
      <label className="strip-fader">
        <span>{t('strip.gain')}</span>
        <input
          type="range"
          data-testid={`fader-${trackId}`}
          aria-label={t('strip.gainLabel', { track: track.name })}
          min={FADER_MIN_MILLI_DB}
          max={FADER_MAX_MILLI_DB}
          step={100}
          value={gain}
          onPointerDown={() => press('gainMilliDb')}
          onChange={change('gainMilliDb')}
        />
        <output data-testid={`fader-value-${trackId}`}>{String(track.gainMilliDb)}</output>
      </label>
      <label className="strip-pan">
        <span>{t('strip.pan')}</span>
        <input
          type="range"
          data-testid={`pan-${trackId}`}
          aria-label={t('strip.panLabel', { track: track.name })}
          min={-PAN_RANGE}
          max={PAN_RANGE}
          step={100}
          value={track.pan}
          onPointerDown={() => press('pan')}
          onChange={change('pan')}
        />
      </label>
      <div className="strip-buttons">
        <button type="button" data-testid={`mute-${trackId}`} aria-pressed={track.mute} onClick={() => toggle('track.set_mute')}>
          M
        </button>
        <button type="button" data-testid={`solo-${trackId}`} aria-pressed={track.solo} onClick={() => toggle('track.set_solo')}>
          S
        </button>
      </div>
    </section>
  );
}
