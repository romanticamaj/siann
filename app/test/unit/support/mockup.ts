// The redesign's mockup as a test oracle (docs/harness/agent-rules.md, "UI
// fidelity"): the expectations of a component port come from the mockup's own
// script, not from the code under test. This reads
// docs/superpowers/specs/2026-11-13-siann-ui-redesign/mockup.html, takes the
// pieces of its script a test names (the formatters and the fader taper, knob(),
// strip(), the master strip, th() (the track header), the track list's and the
// left zone's blocks of the app.innerHTML template with sec() and its icons) and runs them in a vm context whose tok() reads
// the tokens from app/src/renderer/tokens.ts, the mirror of tokens.css the
// mockup reads through getComputedStyle. A tiny HTML parser turns the markup
// they return, and the markup react-dom/server renders, into trees a test can
// walk.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { TOKENS } from '../../../src/renderer/tokens';

function repoRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no mockup.html above ${__dirname}`);
    dir = parent;
  }
}

export const MOCKUP_FILE = path.join(repoRoot(), 'docs', 'superpowers', 'specs', '2026-11-13-siann-ui-redesign', 'mockup.html');

function script(): string {
  const html = fs.readFileSync(MOCKUP_FILE, 'utf8').replace(/\r\n/g, '\n');
  const at = html.indexOf('<script>');
  return html.slice(at + '<script>'.length, html.indexOf('</script>', at));
}

// The source between two markers of the script (the start included).
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`the mockup's script has no ${from}`);
  const end = source.indexOf(to, start + from.length);
  if (end < 0) throw new Error(`the mockup's script has no ${to} after ${from}`);
  return source.slice(start, end);
}

function line(source: string, from: string): string {
  const start = source.indexOf(from);
  if (start < 0) throw new Error(`the mockup's script has no ${from}`);
  return source.slice(start, source.indexOf('\n', start));
}

export interface MockupTrack {
  readonly n: string;
  readonly c: string;
  readonly db: number;
  readonly pan: number;
  readonly m: readonly [number, number];
  readonly pk: number | null;
  readonly ins: readonly string[];
  readonly mute?: boolean;
  readonly sel?: boolean;
  readonly ghost?: boolean;
  // What the mockup's pending plan changes on the track (m5b-ui-ghosts): the
  // new gain (dB), pan (-100..100) or unmute, and the step that does it.
  readonly gDb?: number;
  readonly gPan?: number;
  readonly gUnmute?: boolean;
  readonly gStep?: number;
}

export interface Mockup {
  knob(pan: number): string;
  // knob() with the pending plan's ghost pan and the knob's id (m5b-ui-ghosts).
  knobGhost(pan: number, ghost: number, id: string): string;
  // The Inspector's sec(): .sec with its head and body (m5b-ui-ghosts: Agent changes).
  sec(title: string, body: string, right?: string): string;
  strip(track: MockupTrack, index: number): string;
  readonly master: string;
  pos(db: number): number;
  readonly SCALE: ReadonlyArray<readonly [number, string]>;
  readonly T: readonly MockupTrack[];
  // The left zone (the Inspector) as the app.innerHTML template writes it: aside.leftzone and its rows.
  readonly leftzone: string;
  // The project zone's head as the template writes it: div.arr-toolbar (with tool()) and div.infoline.
  readonly projectHead: string;
  tool(icon: string, key: number, on?: boolean): string;
  // The track header the mockup draws for track `index` of T.
  th(track: MockupTrack, index: number): string;
  // The track list as the app.innerHTML template writes it: div.headers, its head, the marker head and T.map(th).
  readonly headers: string;
  // The mockup's gain and pan formats (fdb(-2.5) = "−2.5", fpan(-35) = "L35").
  fdb(db: number | null): string;
  fpan(pan: number): string;
}

// The mockup's functions with LANG set to `lang` ('en' or 'zh-TW').
export function loadMockup(lang = 'en'): Mockup {
  const source = script();
  const zh = between(source, 'const ZH={', 'const L=');
  const code = [
    `const LANG=${JSON.stringify(lang)};`,
    zh,
    line(source, 'const L='),
    'const tok=n=>{if(!(n in TOKENS))throw new Error("no token --"+n);return TOKENS[n]};',
    line(source, 'const dp='),
    line(source, 'const tk='),
    'const AI=tok(\'ai\');',
    between(source, 'const T=[', '// clips:'),
    between(source, 'const hex=', '/* ============================== knob */'),
    between(source, 'function knob(', '/* ============================== markup */'),
    between(source, 'const th=', '// A MixConsole strip'),
    between(source, 'function strip(', '// clip: the title names a clip'),
    between(source, 'const P={', '// Fidelity ids'),
    line(source, 'const ic='),
    line(source, 'const sec='),
    line(source, 'const tool='),
    // The left zone's block of the app.innerHTML template, evaluated as the template it is.
    `const leftzone=\`${between(source, '<aside class="leftzone"', '<main class="center">').trim()}\`;`,
    // The project zone's toolbar and info line, the block of the template above div.arr-body.
    `const projectHead=\`${between(source, '<div class="arr-toolbar"', '<div class="arr-body"').trim()}\`;`,
    // The track list's block of the template, evaluated the same way.
    `const headers=\`${between(source, '<div class="headers"', '<div class="lanes"').trim()}\`;`,
    'this.out={knob:(p)=>knob(p),knobGhost:(p,g,id)=>knob(p,g,id),sec,strip,master,pos,SCALE,T,leftzone,th,headers,fdb,fpan,projectHead,tool};',
  ].join('\n');
  const context: Record<string, unknown> = { TOKENS, Math, JSON, Error };
  vm.runInNewContext(code, context);
  const out = context.out as Mockup;
  // Data made in the vm's realm is copied into this one, so deepStrictEqual compares it by value.
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    knob: out.knob,
    knobGhost: out.knobGhost,
    sec: out.sec,
    strip: out.strip,
    master: out.master,
    pos: out.pos,
    SCALE: copy(out.SCALE),
    T: copy(out.T),
    leftzone: out.leftzone,
    th: out.th,
    headers: out.headers,
    fdb: out.fdb,
    fpan: out.fpan,
    projectHead: out.projectHead,
    tool: out.tool,
  };
}

// ---------------------------------------------------------------- markup trees

export interface Element {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: Node[];
}
export type Node = Element | string;

const VOID = new Set(['input', 'br', 'img', 'meta', 'link', 'path', 'circle', 'stop', 'rect']);

const decode = (text: string) =>
  text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// Parses well-formed markup (react-dom/server's, or the mockup's templates).
export function parse(markup: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(markup); m; m = re.exec(markup)) {
    const top = stack[stack.length - 1]!;
    if (m[5] !== undefined) {
      if (m[5].trim()) top.children.push(decode(m[5]));
      continue;
    }
    const [, close, tag, rawAttrs, selfClose] = m;
    const name = tag!.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]!.tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs!.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]!] = decode(a[2] ?? '');
    const el: Element = { tag: name, attrs, children: [] };
    top.children.push(el);
    if (!selfClose && !(VOID.has(name) && !markup.startsWith(`</${name}>`, re.lastIndex))) stack.push(el);
  }
  return root;
}

export const elements = (node: Element): Element[] => node.children.filter((c): c is Element => typeof c !== 'string');

export function classes(el: Element): string[] {
  return (el.attrs.class ?? '').split(/\s+/).filter(Boolean);
}

// tag.class1.class2, classes sorted.
export function sig(el: Element): string {
  const cls = classes(el).sort();
  return `${el.tag}${cls.length ? `.${cls.join('.')}` : ''}`;
}

export function text(node: Node): string {
  return typeof node === 'string' ? node : node.children.map(text).join('');
}

// Every element below `node` (itself included) that `match` accepts, in document order.
export function findAll(node: Element, match: (el: Element) => boolean): Element[] {
  const out: Element[] = [];
  const walk = (el: Element) => {
    if (match(el)) out.push(el);
    for (const child of elements(el)) walk(child);
  };
  walk(node);
  return out;
}

export function find(node: Element, match: (el: Element) => boolean): Element {
  const found = findAll(node, match)[0];
  if (!found) throw new Error('no such element');
  return found;
}

export const byClass = (name: string) => (el: Element) => classes(el).includes(name);
export const byAttr = (name: string, value?: string) => (el: Element) => name in el.attrs && (value === undefined || el.attrs[name] === value);

// One declaration of an inline style attribute ("bottom:75.0%" -> "75.0%").
export function styleOf(el: Element, property: string): string | undefined {
  for (const declaration of (el.attrs.style ?? '').split(';')) {
    const at = declaration.indexOf(':');
    if (at > 0 && declaration.slice(0, at).trim() === property) return declaration.slice(at + 1).trim();
  }
  return undefined;
}
