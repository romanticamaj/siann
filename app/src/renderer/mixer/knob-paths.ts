// The pan knob's path data (m5-ui-port-mixer-strip; UI redesign 3.4, 10.9):
// the mockup's knob() on a 24-unit viewBox, the same formulas so the same pan
// gives the same numbers. The track is a 270 degree arc of radius 9.5 from
// hard left (-135 degrees from the top) to hard right (+135); the value arc
// runs from the centre (the top) to the pan, and is absent at C; the needle
// runs from radius 2.5 to radius 6.5 at the pan's angle. The app's pan is
// -10000..10000 (L100..R100); the mockup's -100..100. Pure and DOM-free.

export interface KnobPaths {
  readonly track: string;
  // Null at the centre: knob() draws no arc there.
  readonly arc: string | null;
  readonly needle: string;
  // The pending plan's pan (m5b-ui-ghosts): knob()'s violet tick from radius
  // 5 to radius 10.5 at the new angle, and the dot at its end; null without one.
  readonly ghost: string | null;
  readonly ghostDot: readonly [number, number] | null;
}

const CENTRE = 12;
const TRACK_RADIUS = 9.5;
const NEEDLE_INNER = 2.5;
const NEEDLE_OUTER = 6.5;
const GHOST_INNER = 5;
const GHOST_OUTER = 10.5;

// The angle of a pan of -100..100, in radians from the top, clockwise.
const angle = (p: number) => ((-135 + ((p + 100) / 200) * 270) * Math.PI) / 180;
const point = (a: number, r: number): [number, number] => [CENTRE + r * Math.sin(a), CENTRE - r * Math.cos(a)];

export function knobPaths(pan: number, ghost?: number): KnobPaths {
  const p = pan / 100;
  const [bx0, by0] = point(angle(-100), TRACK_RADIUS);
  const [bx1, by1] = point(angle(100), TRACK_RADIUS);
  const track = `M${bx0} ${by0}A${TRACK_RADIUS} ${TRACK_RADIUS} 0 1 1 ${bx1} ${by1}`;
  let arc: string | null = null;
  if (p !== 0) {
    const a0 = angle(0);
    const a1 = angle(p);
    const [x0, y0] = point(Math.min(a0, a1), TRACK_RADIUS);
    const [x1, y1] = point(Math.max(a0, a1), TRACK_RADIUS);
    arc = `M${x0} ${y0}A${TRACK_RADIUS} ${TRACK_RADIUS} 0 0 1 ${x1} ${y1}`;
  }
  const [nx, ny] = point(angle(p), NEEDLE_OUTER);
  const [cx, cy] = point(angle(p), NEEDLE_INNER);
  if (ghost === undefined) return { track, arc, needle: `M${cx} ${cy}L${nx} ${ny}`, ghost: null, ghostDot: null };
  const g = ghost / 100;
  const [gx, gy] = point(angle(g), GHOST_OUTER);
  const [hx, hy] = point(angle(g), GHOST_INNER);
  return { track, arc, needle: `M${cx} ${cy}L${nx} ${ny}`, ghost: `M${hx} ${hy}L${gx} ${gy}`, ghostDot: [gx, gy] };
}
