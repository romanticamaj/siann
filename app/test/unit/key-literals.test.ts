// No key written outside the key table (m5b-ui-keymap; UI redesign 3.6;
// acceptance 5): the application menu, every tooltip, every kbd and every
// catalog string take a key from the preset (keys/preset-cubase.ts) through
// the formatter (keys/chord-label.ts). Walks every .ts and .tsx source under
// app/src/renderer and app/src/main with the TypeScript compiler API and
// fails on a string literal (or a template literal's text) that is shaped
// like a key: a modifier chord (Ctrl+, Cmd+, Alt+, Opt+, Shift+, Mod+, or a
// macOS glyph), a numpad key (Num 0, Num -), a function key; and, as the
// child of a kbd or the value of title or aria-keyshortcuts, any single key.
// Then the same over the values of the three catalogs. The key table's own
// files are the allowed sources: the preset, the tool
// modifiers and the formatter's name table; and the shell's accelerator map
// (app/src/main/menu.ts acceleratorOf), whose names are Electron's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

import { en } from '../../src/renderer/i18n/en';
import { zhHans } from '../../src/renderer/i18n/zh-Hans';
import { zhHant } from '../../src/renderer/i18n/zh-Hant';

// dist/test/unit -> app/src
const SRC = path.resolve(__dirname, '..', '..', '..', 'src');
const ALLOWED_FILES = new Set(
  ['renderer/keys/preset-cubase.ts', 'renderer/keys/tool-modifiers.ts', 'renderer/keys/chord-label.ts'].map((file) => path.join(SRC, ...file.split('/'))),
);
// The catalogs are checked by value below.
const CATALOG_DIR = path.join(SRC, 'renderer', 'i18n');

const CHORD = /(^|[^\p{L}])(Ctrl|Cmd|Alt|Opt|Option|Shift|Mod|Meta|Control)\+(\S|$)|[⌘⌥⇧⌃]|(^|[^\p{L}])Num [0-9.,\-+*/]|(^|[^\p{L}])Num ?(Enter|Lock)\b|(^|[^\p{L}\d])F([1-9]|1[0-2])($|[^\p{L}\d])/u;
// A single key, where only a key can stand: a letter, a digit, a symbol key or a named key.
const SINGLE = /^(?:[A-Z0-9]|[,./\-=;`]|Space|Enter|Return|Esc|Escape|Tab|Delete|Backspace|Insert|Home|End|PageUp|PageDown)$/;
const KEY_POSITIONS = new Set(['title', 'aria-keyshortcuts']);
// A single key written in brackets inside a catalog sentence: 'Auto-Scroll (F)', '自動捲動（F）', 'Play [Space]'.
const BRACKETED = /[(（[]\s*(?:[A-Z0-9]|[,./\-=;`]|Space|Enter|Return|Esc|Escape|Tab|Delete|Backspace|Insert|Home|End|Page ?Up|Page ?Down|Arrow\w*|[←→↑↓])\s*[)）\]]/u;

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function isKbd(node: ts.Node): boolean {
  const parent = node.parent;
  const element = ts.isJsxExpression(node) || ts.isJsxText(node) ? parent : null;
  if (!element || !ts.isJsxElement(element)) return false;
  return element.openingElement.tagName.getText() === 'kbd';
}

const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

function comparedWith(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) return true;
  return ts.isCaseClause(parent) && parent.expression === node;
}

export function findKeyLiterals(file: string, source: string): Finding[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, kind);
  const findings: Finding[] = [];
  const report = (node: ts.Node, text: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file, line: line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    // Import and export specifiers and module names are no text.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      // A key compared with an event's key (event.key === 'F10', case 'F2':) is read, not written.
      if (comparedWith(node)) return;
      if (CHORD.test(text)) report(node, text);
      const attribute = ts.isJsxAttribute(node.parent) ? node.parent : ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent) ? node.parent.parent : null;
      if (attribute && KEY_POSITIONS.has(attribute.name.getText(sf)) && SINGLE.test(text.trim())) report(node, text);
      if (ts.isJsxExpression(node.parent) && isKbd(node.parent)) report(node, text);
    } else if (ts.isJsxText(node) && isKbd(node) && node.text.trim() !== '') {
      report(node, node.text.trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== CATALOG_DIR) out.push(...sources(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

test('the walker catches each kind of key literal (inline fixtures)', () => {
  const tsx = [
    "export const A = () => <button title='Stop (Num 0)' />;",
    "export const B = () => <span>Show <kbd>F3</kbd></span>;",
    "export const C = (k: string) => <kbd>{'M'}</kbd>;",
    "export const D = () => <i title='J' aria-keyshortcuts='Alt+S' />;",
    "export const E = { label: 'Undo', accelerator: `Ctrl+${'Z'}` };",
    "export const F = '⌘⌥L';",
    "export const G = (key: string) => <kbd>{key}</kbd>;",
    "export const H = () => <i title='Left zone' className='Shift' data-x='Ctrl' />;",
    "import { x } from './Alt+X';",
    "export const I = (e: { key: string }) => e.key === 'F10' || e.key !== 'Shift+F6';",
  ].join('\n');
  assert.deepEqual(
    findKeyLiterals('fixture.tsx', tsx).map((f) => [f.line, f.text]),
    [
      [1, 'Stop (Num 0)'],
      [2, 'F3'],
      [3, 'M'],
      [4, 'J'],
      [4, 'Alt+S'],
      [5, 'Ctrl+'],
      [6, '⌘⌥L'],
    ],
  );
});

test('no key literal in the renderer or the shell outside the key table', () => {
  const findings: Finding[] = [];
  for (const file of [...sources(path.join(SRC, 'renderer')), ...sources(path.join(SRC, 'main'))]) {
    if (ALLOWED_FILES.has(file)) continue;
    findings.push(...findKeyLiterals(file, fs.readFileSync(file, 'utf8')));
  }
  assert.deepEqual(
    findings.map((f) => `${path.relative(SRC, f.file)}:${f.line} ${JSON.stringify(f.text)}`),
    [],
    'key literals: take the key from the preset through keys/chord-label.ts',
  );
});

test('no catalog string writes a key: a key is a {key} placeholder filled by formatChord', () => {
  const found: string[] = [];
  for (const [name, catalog] of [['en', en], ['zh-Hant', zhHant], ['zh-Hans', zhHans]] as const) {
    for (const [key, value] of Object.entries(catalog)) if (typeof value === 'string' && (CHORD.test(value) || BRACKETED.test(value))) found.push(`${name} ${key}: ${value}`);
  }
  assert.deepEqual(found, []);
  // The catalog check sees a bare key in brackets, not only chords: 'Auto-Scroll (F)' wrapped in tipWithKey showed the key twice.
  for (const written of ['Auto-Scroll (F)', '自動捲動（F）', 'Play [Space]', 'Step (Arrow Left)', 'Locate (Home)']) assert.ok(BRACKETED.test(written), written);
  for (const prose of ['Volume (dB)', 'Grid (1/16)', '(optional)', 'Tempo (BPM)']) assert.ok(!BRACKETED.test(prose), prose);
  // The two strings that named keys take them as placeholders now.
  for (const catalog of [en, zhHant, zhHans]) {
    assert.ok(String(catalog['pill.toggle']).includes('{key}'), String(catalog['pill.toggle']));
    assert.ok(String(catalog['info.editHint']).includes('{key}'), String(catalog['info.editHint']));
  }
});
