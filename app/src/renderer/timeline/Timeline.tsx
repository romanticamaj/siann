// The timeline's React chrome (ADR-0019 point 3): it mounts the imperative
// TimelineCanvas on a <canvas> through a ref and renders around it what is
// plain UI: the media pool to place from and the delete button (the project
// zone's toolbar), the selected clip and last refusal (its info line), and the
// event display that holds the canvas. Delete, Backspace and Escape are the
// project zone's key commands (keys/preset-cubase.ts), registered here. No
// drawing state passes through React.
// The capability rule (UI redesign spec 3.0): the media pool's place buttons
// exist only when engine.capabilities lists clip.place, the delete button and
// key only with clip.remove, and the canvas sends no gesture whose commands
// are not listed (it reads the latest capabilities through a ref).
// The canvas words its ruler through the installed locale store and redraws
// when it changes; the chrome reads the same store through useT().

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { refusalLine } from '../i18n/errors';
import { localeStore, translator, useLocale } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { PeaksCache } from '../model/peaks-cache';
import type { SessionClient } from '../model/session-client';
import { Capable, useCapabilities } from '../shell/Capable';
import { TimelineCanvas, type TimelineState, type TimelineTestHooks } from './TimelineCanvas';

const IDLE: TimelineState = { selectedClipId: null, placingMediaId: null, error: null };

export function Timeline({
  client,
  peaks,
  commands,
  onSelect,
  onHooks,
}: {
  client: SessionClient;
  peaks: PeaksCache;
  commands: CommandRegistry;
  // The selected clip, for the left zone.
  onSelect?: (clipId: string | null) => void;
  // Test-only (SIANN_SHELL_TEST=1): the canvas's hooks once it is mounted.
  onHooks?: (hooks: TimelineTestHooks | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const locale = useLocale();
  const t = translator(locale);
  const [timeline, setTimeline] = useState<TimelineCanvas | null>(null);
  const can = useCapabilities();
  const canRef = useRef(can);
  canRef.current = can;
  const canRemove = can.command('clip.remove');
  const canPlace = can.command('clip.place');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const surface = new TimelineCanvas({
      canvas,
      model: client.model,
      peaks,
      execute: (commands, expectedRevision) => client.execute(commands, expectedRevision),
      locale: {
        t: () => translator(localeStore().getSnapshot()),
        subscribe: (listener) => localeStore().subscribe(listener),
      },
      allows: (op) => canRef.current.command(op),
    });
    setTimeline(surface);
    onHooks?.(surface.testHooks());
    return () => {
      onHooks?.(null);
      surface.destroy();
      setTimeline(null);
    };
  }, [client, peaks, onHooks]);

  const state = useSyncExternalStore(
    (listener) => (timeline ? timeline.subscribe(listener) : () => {}),
    () => (timeline ? timeline.getState() : IDLE),
    () => (timeline ? timeline.getState() : IDLE),
  );
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
    () => client.model.getSnapshot(),
  );

  useEffect(() => {
    if (!timeline) return undefined;
    const offs = [commands.register('project', 'edit.cancel', () => timeline.setPlacing(null))];
    if (canRemove) offs.push(commands.register('project', 'edit.delete', () => void timeline.deleteSelected()));
    return () => offs.forEach((off) => off());
  }, [timeline, commands, canRemove]);

  useEffect(() => {
    onSelect?.(state.selectedClipId);
  }, [onSelect, state.selectedClipId]);

  return (
    <section className="timeline">
      <div className="timeline-bar">
        <ul className="media-pool" data-testid="media-pool" aria-label={t('timeline.mediaPool')}>
          {(snapshot?.media ?? []).map((media) => (
            <li key={media.id}>
              {canPlace ? (
                <button
                  type="button"
                  data-testid={`pool-${media.id}`}
                  aria-pressed={state.placingMediaId === media.id}
                  onClick={() => timeline?.setPlacing(state.placingMediaId === media.id ? null : media.id)}
                >
                  {media.id}
                </button>
              ) : (
                <span className="media-name">{media.id}</span>
              )}
            </li>
          ))}
        </ul>
        <Capable command="clip.remove">
        <button
          type="button"
          data-testid="delete-clip"
          disabled={!state.selectedClipId}
          onClick={() => void timeline?.deleteSelected()}
        >
          {t('timeline.deleteClip')}
        </button>
        </Capable>
      </div>
      <dl className="info-line" data-testid="info-line">
        <dt>{t('timeline.selected')}</dt>
        <dd data-testid="selected-clip">{state.selectedClipId ?? ''}</dd>
        <dt>{t('timeline.lastError')}</dt>
        <dd data-testid="timeline-error" data-code={state.error?.code ?? undefined}>
          {state.error ? refusalLine(state.error.code, state.error.message, locale) : ''}
        </dd>
      </dl>
      <div className="event-display" data-testid="event-display">
        <canvas ref={canvasRef} data-testid="timeline-canvas" className="timeline-canvas" />
      </div>
    </section>
  );
}
