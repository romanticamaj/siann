// The mockup's Plans tab as test data (m5-ui-port-plans; UI redesign 10.2 and
// 10.7, 3): the session the pending plan "Lift the chorus" works on (the
// tracks, the Riser clip on FX, the pad's media named pad_swell.wav), its six
// steps as an agent submits them, the plan.preview answer for it, and three
// earlier plans (applied with 4 steps, rejected with the mockup's note, made
// stale). And readers of mockup.html itself, so expectations come from the
// reference and are not retyped: its ZH table, its step() function and the
// right zone's markup block, evaluated with stand-ins for the helpers
// (dp, dr, ic, L) that only keep the structure.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { MediaEntity, TrackEntity } from '../../../src/renderer/model/document';
import { planEntry, type PlanEntry } from '../../../src/renderer/model/plan-store';
import type { Snapshot } from '../../../src/renderer/model/read-model';
import type { PlanPreview } from '../../../src/renderer/plans/diff';
import { clip, media, snapshotOf, track } from './timeline';

const RATE = 48000;
export const BAR = 2 * RATE;

// dist/test/unit/support -> the repository root.
export const MOCKUP_PATH = path.resolve(__dirname, '..', '..', '..', '..', '..', 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html');
export const MOCKUP = fs.readFileSync(MOCKUP_PATH, 'utf8').replace(/\r\n/g, '\n');

export const T = {
  kick: 'trk_kick',
  snare: 'trk_snare',
  bass: 'trk_bass',
  keys: 'trk_keys',
  lead: 'trk_lead',
  bg: 'trk_bg',
  fx: 'trk_fx',
  pad: 'trk_pad',
} as const;
export const RISER = 'clp_riser';

const named = (id: string, name: string, extra: Partial<TrackEntity> = {}): TrackEntity => ({ ...track(id), name, channels: 1, ...extra });

export function mockupTracks(): TrackEntity[] {
  return [
    named(T.kick, 'Kick'),
    named(T.snare, 'Snare', { gainMilliDb: -2500 }),
    named(T.bass, 'Bass', { gainMilliDb: -4000 }),
    named(T.keys, 'Keys', { gainMilliDb: -8000, pan: -3500 }),
    named(T.lead, 'Vox Lead', { gainMilliDb: 1500 }),
    named(T.bg, 'Vox BG', { gainMilliDb: -9000, pan: 4000 }),
    named(T.fx, 'FX', { gainMilliDb: -12000, mute: true }),
  ];
}

export function mockupSnapshot(): Snapshot {
  const tracks = mockupTracks();
  const pad: MediaEntity = { ...media('med_pad', String(16 * RATE)), name: 'pad_swell.wav' };
  return snapshotOf(
    tracks.map((t) => t.id),
    tracks,
    [pad, media('med_fx', String(16 * RATE))],
    [clip(RISER, T.fx, 'med_fx', String(5 * BAR), '0', String(2 * BAR))],
    'r39',
  );
}

// The pending plan's six steps (mockup-fidelity.spec.ts submits the same).
export const MOCKUP_STEPS: ReadonlyArray<Record<string, unknown>> = [
  { op: 'track.add', trackId: T.pad, name: 'Pad', channels: 2 },
  { op: 'clip.place', clipId: 'clp_pad_swell', trackId: T.pad, mediaId: 'med_pad', position: { domain: 'audio', value: String(8 * BAR) }, sourceStart: '0', length: String(8 * BAR) },
  { op: 'track.set_gain', trackId: T.bg, gainMilliDb: -6000 },
  { op: 'track.set_pan', trackId: T.keys, pan: -2000 },
  { op: 'track.set_mute', trackId: T.fx, mute: false },
  { op: 'clip.move', clipId: RISER, position: { domain: 'audio', value: String(6 * BAR) } },
];

// plan.preview for the pending plan: before is the head, after the plan applied.
export function mockupPreview(): PlanPreview {
  const tracks = new Map(mockupTracks().map((t) => [t.id, t as unknown as Record<string, unknown>]));
  const riser = clip(RISER, T.fx, 'med_fx', String(5 * BAR), '0', String(2 * BAR)) as unknown as Record<string, unknown>;
  const order = mockupTracks().map((t) => t.id);
  return {
    revision: 'r39',
    documentHash: `sha256:${'d'.repeat(64)}`,
    stale: [],
    entities: [
      { ref: 'root:root', before: { id: 'root', trackOrder: order }, after: { id: 'root', trackOrder: [...order, T.pad] } },
      { ref: `track:${T.pad}`, before: null, after: { ...track(T.pad), name: 'Pad' } },
      { ref: 'clip:clp_pad_swell', before: null, after: clip('clp_pad_swell', T.pad, 'med_pad', String(8 * BAR), '0', String(8 * BAR)) as unknown as Record<string, unknown> },
      { ref: `track:${T.bg}`, before: tracks.get(T.bg)!, after: { ...tracks.get(T.bg)!, gainMilliDb: -6000 } },
      { ref: `track:${T.keys}`, before: tracks.get(T.keys)!, after: { ...tracks.get(T.keys)!, pan: -2000 } },
      { ref: `track:${T.fx}`, before: tracks.get(T.fx)!, after: { ...tracks.get(T.fx)!, mute: false } },
      { ref: `clip:${RISER}`, before: riser, after: { ...riser, position: { domain: 'audio', value: String(6 * BAR) } } },
    ],
  };
}

export const hashOf = (digit: string) => 'sha256:' + digit.repeat(64);
export const PENDING = hashOf('8');
export const APPLIED = hashOf('a');
export const REJECTED = hashOf('b');
export const STALE = hashOf('c');
export const NOTE = 'Too wide for the verse — keep it mono.';

function plan(hash: string, state: string, steps: ReadonlyArray<Record<string, unknown>>, extra: Record<string, unknown> = {}): PlanEntry {
  return planEntry({ schema: 'siann.plan.v1', hash, state, baseRevision: 'r39', steps, readSet: [], writeSet: [], stale: [], ...extra })!;
}

// Submission order: stale, rejected, applied, pending (UI redesign 10.2).
export function mockupPlans(): PlanEntry[] {
  return [
    plan(STALE, 'approved', [{ op: 'track.set_gain', trackId: T.kick, gainMilliDb: -1000 }], {
      baseRevision: 'r27',
      stale: [{ ref: `track:${T.kick}`, change: 'modified' }],
    }),
    plan(REJECTED, 'rejected', [{ op: 'track.set_pan', trackId: T.lead, pan: 3000 }], { rejectionNote: NOTE }),
    plan(
      APPLIED,
      'applied',
      [
        { op: 'track.set_gain', trackId: T.kick, gainMilliDb: 0 },
        { op: 'track.set_gain', trackId: T.snare, gainMilliDb: -2500 },
        { op: 'track.set_gain', trackId: T.bass, gainMilliDb: -4000 },
        { op: 'track.set_pan', trackId: T.keys, pan: -3500 },
      ],
      { appliedRevision: 'r31', baseRevision: 'r30' },
    ),
    plan(PENDING, 'validated', MOCKUP_STEPS),
  ];
}

// ---- readers of the mockup

// The mockup's ZH table, evaluated from its source.
export function mockupZh(): Record<string, string> {
  const at = MOCKUP.indexOf('const ZH={');
  const end = MOCKUP.indexOf('\n};', at);
  if (at < 0 || end < 0) throw new Error('the mockup has no ZH table');
  return new Function(`return ${MOCKUP.slice(at + 'const ZH='.length, end + 2)};`)() as Record<string, string>;
}

const dp = (id: string) => `data-part="${id}"`;
const dr = (id: string) => `data-region="${id}"`;
const ic = (name: string, c = '') => `<svg class="i ${c}" viewBox="0 0 16 16" data-icon="${name}"></svg>`;

// The mockup's step() with structural stand-ins, and L for a locale.
function stepFunction(L: (s: string) => string): (...args: unknown[]) => string {
  const at = MOCKUP.indexOf('const step=');
  const end = MOCKUP.indexOf('\nconst tool=', at);
  if (at < 0 || end < 0) throw new Error('the mockup has no step()');
  const source = MOCKUP.slice(at, end).trim().replace(/;$/, '');
  return new Function('dp', 'ic', 'L', `${source}; return step;`)(dp, ic, L) as (...args: unknown[]) => string;
}

// The right zone's markup (<aside class="plans" ...> ... </aside>) as the
// mockup's template renders it, the colours left as token names.
export function mockupRightZone(lang: 'en' | 'zh-TW' = 'en'): string {
  const zh = mockupZh();
  const L = (s: string) => (lang.startsWith('zh') && zh[s] !== undefined ? zh[s]! : s);
  const at = MOCKUP.indexOf('<aside class="plans"');
  const end = MOCKUP.indexOf('</aside>', at);
  if (at < 0 || end < 0) throw new Error('the mockup has no right zone');
  const block = MOCKUP.slice(at, end + '</aside>'.length);
  const tok = (name: string) => `var(--${name})`;
  return new Function('dp', 'dr', 'ic', 'L', 'step', 'tok', 'AI', `return \`${block}\`;`)(dp, dr, ic, L, stepFunction(L), tok, tok('ai')) as string;
}

// ---- a small markup tree, for comparing structures

export interface Node {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly classes: readonly string[];
  readonly children: Node[];
  // The text directly inside (not in children), concatenated.
  text: string;
}

const VOID = /^(input|br|img|meta|link|path|rect|circle|stop)$/;

export function parse(markup: string): Node {
  const root: Node = { tag: '#root', attrs: {}, classes: [], children: [], text: '' };
  const stack: Node[] = [root];
  const re = /<(\/?)([a-zA-Z0-9]+)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    const [, close, tag, rawAttrs, selfClose, text] = m;
    const top = stack[stack.length - 1]!;
    if (text !== undefined) {
      top.text += text.replace(/<!-- -->/g, '');
      continue;
    }
    const name = tag!.toLowerCase();
    if (close) {
      while (stack.length > 1 && stack[stack.length - 1]!.tag !== name) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(/([a-zA-Z_:-][\w:.-]*)(?:="([^"]*)")?/g)) attrs[a[1]!] = a[2] ?? '';
    const node: Node = { tag: name, attrs, classes: (attrs.class ?? '').split(/\s+/).filter(Boolean), children: [], text: '' };
    top.children.push(node);
    if (!selfClose && !VOID.test(name)) stack.push(node);
  }
  return root;
}

export function find(node: Node, pred: (n: Node) => boolean): Node | undefined {
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = find(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

export function findAll(node: Node, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (pred(node)) out.push(node);
  for (const child of node.children) findAll(child, pred, out);
  return out;
}

// "tag.class1.class2[part]" of a node.
export function sig(node: Node): string {
  const part = node.attrs['data-part'] ?? node.attrs['data-part-item'];
  return `${node.tag}${node.classes.map((c) => `.${c}`).join('')}${part ? `[${part}]` : ''}`;
}

// All text below a node, comments removed.
export function textOf(node: Node): string {
  return node.text + node.children.map(textOf).join('');
}
