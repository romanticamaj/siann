// The timeline's React chrome (ADR-0019 point 3): it mounts the imperative
// TimelineCanvas on a <canvas> through a ref and renders around it what is
// plain UI: the media pool to place from, the delete button and key, and the
// selected clip and last refusal. No drawing state passes through React.
// The canvas words its ruler through the installed locale store and redraws
// when it changes; the chrome reads the same store through useT().

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { refusalLine } from '../i18n/errors';
import { localeStore, translator, useLocale } from '../i18n/t';
import type { PeaksCache } from '../model/peaks-cache';
import type { SessionClient } from '../model/session-client';
import { TimelineCanvas, type TimelineState, type TimelineTestHooks } from './TimelineCanvas';

const IDLE: TimelineState = { selectedClipId: null, placingMediaId: null, error: null };

export function Timeline({
  client,
  peaks,
  onHooks,
}: {
  client: SessionClient;
  peaks: PeaksCache;
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
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') void timeline.deleteSelected();
      if (event.key === 'Escape') timeline.setPlacing(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [timeline]);

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
      <canvas ref={canvasRef} data-testid="timeline-canvas" className="timeline-canvas" />
      <dl>
        <dt>{t('timeline.selected')}</dt>
        <dd data-testid="selected-clip">{state.selectedClipId ?? ''}</dd>
        <dt>{t('timeline.lastError')}</dt>
        <dd data-testid="timeline-error" data-code={state.error?.code ?? undefined}>
          {state.error ? refusalLine(state.error.code, state.error.message, locale) : ''}
        </dd>
      </dl>
    </section>
  );
}
