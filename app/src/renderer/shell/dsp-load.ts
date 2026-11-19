// The top bar's DSP load (m5b-ui-meter; UI redesign 2.1, UR-14): the bar's
// width, the percentage and the tooltip (the peak) follow engine.status's
// load {average, peak} from the once-a-second poll. The load changes with
// every poll, so it never passes through React (spec 5.6: no commit while
// playing): bindDspLoad writes the three through the elements' refs from the
// EngineStatusStore's load channel. Framework-free.

import { formatLoadPercent, loadBarWidth } from '../format';
import type { EngineLoad, EngineLoadSource } from '../model/engine-status';

export interface DspLoadTargets {
  // span.dsp: the tooltip, and the meter's value for assistive technology.
  readonly root: { title: string; setAttribute(name: string, value: string): void };
  // .bar > i
  readonly bar: { readonly style: { width: string } };
  // .num
  readonly num: { textContent: string | null };
}

// Writes the load now and on every change; returns the unbinding.
export function bindDspLoad(source: EngineLoadSource, targets: DspLoadTargets, peakTooltip: (percent: string) => string): () => void {
  let shown: EngineLoad | null | undefined;
  const write = () => {
    const load = source.getLoad();
    if (shown !== undefined && load === shown) return;
    shown = load;
    const average = load?.average ?? 0;
    targets.bar.style.width = loadBarWidth(average);
    targets.num.textContent = formatLoadPercent(average);
    targets.root.title = load ? peakTooltip(formatLoadPercent(load.peak)) : '';
    targets.root.setAttribute('aria-valuenow', String(average > 0 ? Math.round(average * 100) : 0));
  };
  write();
  return source.subscribeLoad(write);
}
