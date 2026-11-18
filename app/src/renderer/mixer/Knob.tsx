// The pan knob (m5-ui-port-mixer-strip; UI redesign 3.4, 10.9): the SVG the
// mockup's knob() returns, from the pan value. svg.knob (24 px, ui/lower-zone.css)
// holds the 270 degree track, the value arc from the centre (absent at C), the
// cap (a ring on --button-line with a --divider edge and a face on the #kg
// gradient, whose definition the Mixer renders once: KnobGradient) and the
// needle. Colours are the tokens' values, as knob() reads them. A pending
// plan's pan (m5b-ui-ghosts) adds knob()'s ghost group: the violet tick at the
// new angle and its dot, with the knob's part id and -ghost. The svg takes the
// caller's attributes, so the strip makes it the pan slider.

import type { Ref, SVGProps } from 'react';

import { TOKENS } from '../tokens';
import { knobPaths } from './knob-paths';

export interface KnobProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  // -10000 (L100) .. 10000 (R100).
  readonly pan: number;
  // The pending plan's pan (m5b-ui-ghosts).
  readonly ghost?: number;
  readonly ref?: Ref<SVGSVGElement>;
}

export function Knob({ pan, ghost, ref, ...rest }: KnobProps) {
  const paths = knobPaths(pan, ghost);
  const part = (rest as Record<string, unknown>)['data-part-of'];
  return (
    <svg className="knob" viewBox="0 0 24 24" ref={ref} {...rest}>
      <path d={paths.track} stroke={TOKENS['bg-slot']} strokeWidth="2.4" fill="none" strokeLinecap="round" />
      {paths.arc === null ? null : <path data-knob="arc" d={paths.arc} stroke={TOKENS['tx-1']} strokeWidth="2" fill="none" strokeLinecap="round" />}
      <circle cx="12" cy="12" r="7" fill={TOKENS['button-line']} stroke={TOKENS.divider} />
      <circle cx="12" cy="11.5" r="6.2" fill="url(#kg)" />
      <path data-knob="needle" d={paths.needle} stroke={TOKENS['tx-0']} strokeWidth="1.6" strokeLinecap="round" />
      {paths.ghost !== null && paths.ghostDot !== null ? (
        <g data-part-of={typeof part === 'string' ? `${part}-ghost` : undefined} data-ghost="">
          <path d={paths.ghost} stroke={TOKENS.ai} strokeWidth="2" strokeLinecap="round" />
          <circle cx={paths.ghostDot[0]} cy={paths.ghostDot[1]} r="2" fill={TOKENS.ai} />
        </g>
      ) : null}
    </svg>
  );
}

// The cap's gradient (the mockup's <defs>): rendered once, beside the strips.
export function KnobGradient() {
  return (
    <svg className="knob-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="kg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={TOKENS['knob-0']} />
          <stop offset="1" stopColor={TOKENS.line} />
        </linearGradient>
      </defs>
    </svg>
  );
}
