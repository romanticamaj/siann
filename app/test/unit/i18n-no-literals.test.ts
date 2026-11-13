// No UI literals in the renderer (m5-ui-i18n; UI redesign spec 6.3): walks
// every .ts and .tsx source under app/src/renderer with the TypeScript
// compiler API and fails on JSX text, on string literals (and the literal
// text of template literals) given as JSX children or in the attributes
// title, aria-label, placeholder and alt, and on the same in the first
// argument of fillText, outside an allow-list of fixed symbols. The
// catalogs in renderer/i18n are the strings' home and are not walked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

// dist/test/unit -> app/src/renderer
const RENDERER = path.resolve(__dirname, '..', '..', '..', 'src', 'renderer');
const CATALOG_DIR = path.join(RENDERER, 'i18n');

// The fixed symbols of spec 6.2 (the same in every locale).
const ALLOWED = new Set(['M', 'S', 'R', 'W', 'e', 'dB', 'L', 'C']);
const LABEL_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt']);

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly where: string;
}

function allowed(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || ALLOWED.has(trimmed) || !/\p{L}/u.test(trimmed);
}

// The literal texts an expression contributes directly: a string literal, the
// literal parts of a template, through parentheses, conditionals, ?? / || and
// string concatenation. Calls and identifiers contribute none.
function literalTexts(node: ts.Node): ts.Node[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node];
  if (ts.isTemplateExpression(node)) return [node.head, ...node.templateSpans.map((s) => s.literal)];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return literalTexts(node.expression);
  if (ts.isConditionalExpression(node)) return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return [...(op === ts.SyntaxKind.AmpersandAmpersandToken ? [] : literalTexts(node.left)), ...literalTexts(node.right)];
    }
  }
  return [];
}

function textOf(node: ts.Node): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return node.text;
  return node.getText();
}

export function findLiterals(file: string, source: string): Finding[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, kind);
  const findings: Finding[] = [];
  const report = (node: ts.Node, where: string, text = textOf(node)) => {
    if (allowed(text)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file, line: line + 1, text: text.trim(), where });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, 'JSX text', node.text);
    else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const lit of literalTexts(node.expression)) report(lit, 'JSX child');
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (LABEL_ATTRIBUTES.has(name) && node.initializer) {
        const init = node.initializer;
        const nodes = ts.isStringLiteral(init) ? [init] : ts.isJsxExpression(init) && init.expression ? literalTexts(init.expression) : [];
        for (const lit of nodes) report(lit, `${name}=`);
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'fillText' && node.arguments[0]) {
        for (const lit of literalTexts(node.arguments[0])) report(lit, 'fillText');
      }
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

test('the walker catches each kind of literal (inline fixtures)', () => {
  const tsx = [
    'export const A = () => <p>Hello</p>;',
    "export const B = (n: string) => <input title='Name' aria-label={`${n} gain`} placeholder={'Type'} alt={n ? 'Yes' : 'No'} />;",
    "export const C = (n: number) => <span>{n} step{n === 1 ? '' : 's'}</span>;",
    'export const D = () => <b>M</b>;',
    "export const E = (t: (k: string) => string) => <i title={t('x')}>{t('y')}{' '}—</i>;",
  ].join('\n');
  const found = findLiterals('fixture.tsx', tsx);
  assert.deepEqual(
    found.map((f) => [f.line, f.where, f.text]),
    [
      [1, 'JSX text', 'Hello'],
      [2, 'title=', 'Name'],
      [2, 'aria-label=', 'gain'],
      [2, 'placeholder=', 'Type'],
      [2, 'alt=', 'Yes'],
      [2, 'alt=', 'No'],
      [3, 'JSX text', 'step'],
      [3, 'JSX child', 's'],
    ],
  );
  const canvas = [
    'declare const ctx: CanvasRenderingContext2D; declare const t: number; declare const name: string;',
    "ctx.fillText('Bar', 0, 0);",
    'ctx.fillText(`${t}s`, 0, 0);',
    'ctx.fillText(name, 0, 0);',
    "ctx.fillText(String(t) + ' dB', 0, 0);",
    "ctx.fillText('C', 0, 0);",
  ].join('\n');
  assert.deepEqual(
    findLiterals('fixture.ts', canvas).map((f) => [f.line, f.text]),
    [
      [2, 'Bar'],
      [3, 's'],
    ],
  );
});

test('the renderer sources hold no UI literals outside the catalogs', () => {
  const files = sources(RENDERER);
  assert.ok(files.some((f) => f.endsWith('StatusPanel.tsx')), `no sources found under ${RENDERER}`);
  const findings = files.flatMap((file) => findLiterals(path.relative(RENDERER, file), fs.readFileSync(file, 'utf8')));
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} ${f.where} ${JSON.stringify(f.text)}`),
    [],
  );
});
