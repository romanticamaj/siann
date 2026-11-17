// The pan knob (m5-ui-port-mixer-strip; UI redesign 10.9, 3.4): the Knob
// component returns the SVG of the mockup's knob() for the same pan, read from
// the mockup's own script (support/mockup.ts), not from the code under test:
// the 270 degree track (r 9.5, width 2.4), the value arc from the centre
// (absent at C, width 2), the cap's two circles (r 7 on --button-line with a
// --divider stroke, r 6.2 on the #kg gradient) and the needle from r 2.5 to
// r 6.5 (width 1.6). The app's pan is -10000..10000; the mockup's -100..100.
// The colours are the tokens' values, and M5 draws no ghost (m5b-ui-ghosts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import { Knob } from '../../src/renderer/mixer/Knob';
import { knobPaths } from '../../src/renderer/mixer/knob';
import { TOKENS } from '../../src/renderer/tokens';
import { elements, find, findAll, loadMockup, parse, type Element } from './support/mockup';

const MOCKUP = loadMockup();

// The mockup's pan (-100..100) and the app's (-10000..10000): C, L35, R100, L100.
const CASES: ReadonlyArray<readonly [string, number]> = [
  ['C', 0],
  ['L35', -35],
  ['R100', 100],
  ['L100', -100],
];

function svgOf(markup: string): Element {
  return find(parse(markup), (el) => el.tag === 'svg');
}

// The drawing, element by element, with the attributes that draw it.
function drawing(svg: Element): string[] {
  const keep = ['d', 'cx', 'cy', 'r', 'fill', 'stroke', 'stroke-width', 'stroke-linecap'];
  return elements(svg)
    .filter((el) => el.tag === 'path' || el.tag === 'circle' || el.tag === 'g')
    .map((el) => `${el.tag} ${keep.filter((k) => k in el.attrs).map((k) => `${k}=${el.attrs[k]}`).join(' ')}`);
}

for (const [name, pan] of CASES) {
  test(`Knob at ${name} draws knob()'s SVG: track, value arc, cap and needle`, () => {
    const mockup = svgOf(MOCKUP.knob(pan));
    const app = svgOf(renderToStaticMarkup(<Knob pan={pan * 100} />));
    assert.equal(app.attrs.class, 'knob');
    assert.equal(app.attrs.viewBox, mockup.attrs.viewBox);
    assert.deepEqual(drawing(app), drawing(mockup));
  });
}

test('the path maths: the track spans 270 degrees, the arc runs from the centre and is absent at C', () => {
  for (const [name, pan] of CASES) {
    const paths = knobPaths(pan * 100);
    const mockup = findAll(svgOf(MOCKUP.knob(pan)), (el) => el.tag === 'path').map((el) => el.attrs.d);
    // knob() draws the track, the arc (not at C) and the needle, in that order.
    assert.deepEqual([paths.track, ...(paths.arc === null ? [] : [paths.arc]), paths.needle], mockup, name);
  }
  assert.equal(knobPaths(0).arc, null);
  // A pan between whole percents draws where the mockup's would for the same fraction.
  assert.equal(knobPaths(-3550).needle, findAll(svgOf(MOCKUP.knob(-35.5)), (el) => el.tag === 'path').at(-1)!.attrs.d);
  assert.match(knobPaths(-10000).track, /^M[\d.-]+ [\d.-]+A9\.5 9\.5 0 1 1 [\d.-]+ [\d.-]+$/);
});

test('the knob\'s colours are the tokens\' values, and M5 draws no ghost', () => {
  const svg = svgOf(renderToStaticMarkup(<Knob pan={-3500} />));
  const [track, arc, outer, cap, needle] = elements(svg);
  assert.equal(track!.attrs.stroke, TOKENS['bg-slot']);
  assert.equal(track!.attrs['stroke-width'], '2.4');
  assert.equal(arc!.attrs.stroke, TOKENS['tx-1']);
  assert.equal(arc!.attrs['stroke-width'], '2');
  assert.equal(outer!.attrs.fill, TOKENS['button-line']);
  assert.equal(outer!.attrs.stroke, TOKENS.divider);
  assert.equal(outer!.attrs.r, '7');
  assert.equal(cap!.attrs.fill, 'url(#kg)');
  assert.equal(cap!.attrs.r, '6.2');
  assert.equal(needle!.attrs.stroke, TOKENS['tx-0']);
  assert.equal(needle!.attrs['stroke-width'], '1.6');
  assert.equal(findAll(svg, (el) => el.tag === 'g').length, 0, 'no ghost group');
  // Decorative paths: the slider is the svg itself (its role and value live on it).
  assert.equal(elements(svg).length, 5);
});
