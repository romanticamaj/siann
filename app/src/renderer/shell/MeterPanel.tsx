// The Meter tab's panel (m5b-ui-meter; UI redesign UR-14, 2.1, 5.3). The
// mockup draws the tab's label only; the panel is built from the shared rules
// and tokens (decided with the feature: no colour or size literal):
//
//   div.meter-panel             (shell.css: the zone body's column)
//     div.z-head                the zone head (ui/left-zone.css): the master's name
//     div.meter-panel-body
//       div.meter > div.ch x2   the master's channel wells (ui/lower-zone.css),
//                               --meter-scale-h high and --meter-master-w wide
//       div.meter-panel-values  .readout rows: the peak value (the strip's
//                               PeakValue: a click resets the hold lines, the
//                               peak and the clip), momentary, short-term and
//                               integrated loudness, each a label, the value
//                               and LUFS; then Reset (.btn, ui/right-zone.css),
//                               which restarts the integrated value
//                               (meter.reset_loudness, only when listed)
//     canvas.meter-panel-canvas the panel's meter surface
//
// The surface is a MixerMeters of its own (meter-board.ts) over the MeterStore
// the MixConsole draws from, so both meters show the same ballistics, and it
// writes the peak value and the three loudness values with textContent from
// its animation frame: no meter or loudness value passes through React
// (ADR-0019 point 3). It stops when nothing changes or the window is hidden.

import { useEffect, useRef, type CSSProperties } from 'react';

import { useT } from '../i18n/t';
import { MeterBoard } from '../mixer/meter-board';
import { MetersContext } from '../mixer/meters-context';
import { LoudnessValue, Meter, PeakValue } from '../mixer/Strip';
import type { LoudnessField } from '../model/loudness-store';
import type { MeterStore } from '../model/meter-store';
import type { RealtimeClient } from '../model/realtime-client';
import type { SessionClient } from '../model/session-client';
import { Capable } from './Capable';
import { Counted } from './Counted';

export interface MeterPanelProps {
  readonly client: Pick<SessionClient, 'resetLoudness'>;
  readonly realtime: Pick<RealtimeClient, 'subscribe' | 'subscribeLoudness' | 'loudness'>;
  // The MixConsole's store, shared.
  readonly store: MeterStore;
}

const QUIET: CSSProperties = { color: 'var(--tx-4)' };

const ROWS: ReadonlyArray<readonly [LoudnessField, 'meter.momentary' | 'meter.shortTerm' | 'meter.integrated', string]> = [
  ['momentary', 'meter.momentary', 'loudness-momentary'],
  ['shortTerm', 'meter.shortTerm', 'loudness-short-term'],
  ['integrated', 'meter.integrated', 'loudness-integrated'],
];

export function MeterPanel({ client, realtime, store }: MeterPanelProps) {
  const t = useT();
  // One board for the panel's lifetime (a ref: it holds no value React shows).
  const boardRef = useRef<MeterBoard | null>(null);
  boardRef.current ??= new MeterBoard(store, realtime.loudness);
  const board = boardRef.current;
  const container = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = container.current;
    const surface = canvas.current;
    if (!el || !surface) return undefined;
    const meters = board.meters;
    board.mount(el, surface);
    const offFrames = realtime.subscribe(() => meters.onFrame());
    const offLoudness = realtime.subscribeLoudness(() => meters.onLoudness());
    const visible = () => meters.wake();
    document.addEventListener('visibilitychange', visible);
    return () => {
      offFrames();
      offLoudness();
      document.removeEventListener('visibilitychange', visible);
      board.mount(null, null);
    };
  }, [board, realtime]);

  return (
    <Counted id="meter-panel">
      <MetersContext.Provider value={board}>
        <div className="meter-panel" data-testid="meter-panel" ref={container}>
          <div className="z-head">{t('meter.master')}</div>
          <div className="meter-panel-body">
            <Meter meterRef="master" testId="meter-panel-master" partOf={null} />
            <div className="meter-panel-values">
              <div className="readout">
                <span style={QUIET}>{t('meter.peak')}</span>
                <PeakValue meterRef="master" testId="meter-panel-peak" label={t('meter.masterPeak')} />
              </div>
              {ROWS.map(([field, label, testId]) => (
                <div key={field} className="readout">
                  <span style={QUIET}>{t(label)}</span>
                  <LoudnessValue field={field} testId={testId} />
                  <span style={QUIET}>{t('meter.lufs')}</span>
                </div>
              ))}
              <Capable method="meter.reset_loudness">
                <button type="button" className="btn" data-testid="meter-reset-loudness" onClick={() => void client.resetLoudness().catch(() => undefined)}>
                  {t('meter.reset')}
                </button>
              </Capable>
            </div>
          </div>
          <canvas className="meter-panel-canvas" ref={canvas} aria-hidden="true" />
        </div>
      </MetersContext.Provider>
    </Counted>
  );
}
