// The timeline's React chrome (ADR-0019 point 3): it mounts the imperative
// TimelineCanvas on a <canvas> through a ref and renders around it what is
// plain UI: the media pool to place from and the delete button (the project
// zone's toolbar), the selected clip and last refusal (its info line), and the
// event display that holds the canvas. Delete, Backspace and Escape are the
// project zone's key commands (keys/preset-cubase.ts), registered here. No
// drawing state passes through React.
// The canvas words its ruler through the installed locale store and redraws
// when it changes; the chrome reads the same store through useT().

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { refusalLine } from '../i18n/errors';
import { localeStore, translator, useLocale } from '../i18n/t';
import type { CommandRegistry } from '../keys/commands';
import type { PeaksCache } from '../model/peaks-cache';
import type { SessionClient } from '../model/session-client';
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
  );
  const snapshot = useSyncExternalStore(
    (listener) => client.model.subscribe(listener),
    () => client.model.getSnapshot(),
  );

  useEffect(() => {
    if (!timeline) return undefined;
    const offs = [
      commands.register('project', 'edit.delete', () => void timeline.deleteSelected()),
      commands.register('project', 'edit.cancel', () => timeline.setPlacing(null)),
    ];
    return () => offs.forEach((off) => off());
  }, [timeline, commands]);

  useEffect(() => {
    onSelect?.(state.selectedClipId);
  }, [onSelect, state.selectedClipId]);

  return (
    <section className="timeline">
      <div className="timeline-bar">
        <ul className="media-pool" data-testid="media-pool" aria-label={t('timeline.mediaPool')}>
          {(snapshot?.media ?? []).map((media) => (
            <li key={media.id}>
              <button
                type="button"
                data-testid={`pool-${media.id}`}
                aria-pressed={state.placingMediaId === media.id}
                onClick={() => timeline?.setPlacing(state.placingMediaId === media.id ? null : media.id)}
              >
                {media.id}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          data-testid="delete-clip"
          disabled={!state.selectedClipId}
          onClick={() => void timeline?.deleteSelected()}
        >
          {t('timeline.deleteClip')}
        </button>
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
