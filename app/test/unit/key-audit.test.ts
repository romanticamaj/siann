// The key-command audit (m5b-ui-keymap; UI redesign 3.6, UR-11; acceptance
// 1): the Cubase preset against keys/cubase-reference.ts, the checked-in
// transcription of research/cubase.md section 7. Every row is bound to its
// chord in the preset with the same command, or carries one of the three
// reasons (no backend yet, naming its ticket or milestone; not planned;
// replaced by a SIANN addition); every preset chord that Cubase gives to
// another command is listed in DIFFERENCES; and the transcription is checked
// against the research file itself, so a row cannot silently go missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { COMMAND_IDS } from '../../src/renderer/keys/commands';
import { CUBASE_REFERENCE, DIFFERENCES, type ReferenceRow } from './support/cubase-reference';
import { CUBASE_PRESET } from '../../src/renderer/keys/preset-cubase';

// dist/test/unit -> the repository root
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const RESEARCH = path.join(ROOT, 'docs', 'superpowers', 'research', '2026-11-13-cubase-reference.md');

// A ticket or milestone: an engine ticket, a feature id, a milestone or a phase.
const REF = /^(E-\d+|m\d+[a-z]?-[a-z0-9-]+|M\d+[a-c]?|phase [3-5])$/;

const where = (row: ReferenceRow) => `${row.section} ${row.command} (${row.key} -> ${row.chord})`;

test('every reference row is bound to its chord with the same command, or carries a reason', () => {
  const failures: string[] = [];
  for (const row of CUBASE_REFERENCE) {
    if (row.commandId !== undefined && row.reason !== undefined) failures.push(`${where(row)}: both a command and a reason`);
    if (row.commandId !== undefined) {
      if (!COMMAND_IDS.includes(row.commandId)) failures.push(`${where(row)}: ${row.commandId} is no command`);
      if (!CUBASE_PRESET.some((b) => b.chord === row.chord && b.commandId === row.commandId)) failures.push(`${where(row)}: the preset does not bind it to ${row.commandId}`);
    } else if (row.reason === undefined) {
      failures.push(`${where(row)}: neither a command nor a reason`);
    } else if (row.reason.kind === 'no-backend') {
      if (!REF.test(row.reason.ref)) failures.push(`${where(row)}: no backend names no ticket or milestone: "${row.reason.ref}"`);
    } else if (row.reason.kind === 'not-planned') {
      if (row.reason.why.trim() === '') failures.push(`${where(row)}: not planned without a why`);
    } else if (row.reason.kind === 'siann-addition') {
      if (row.reason.note.trim() === '') failures.push(`${where(row)}: a SIANN addition without its note`);
    } else {
      failures.push(`${where(row)}: an unknown reason`);
    }
  }
  assert.deepEqual(failures, []);
});

test('the key a SIANN addition takes from Cubase is bound in the preset', () => {
  for (const row of CUBASE_REFERENCE) {
    if (row.reason === undefined) continue;
    const bound = CUBASE_PRESET.filter((b) => b.chord === row.chord);
    if (row.reason.kind === 'siann-addition') assert.ok(bound.length > 0, `${where(row)}: a SIANN addition the preset does not bind`);
  }
});

test('every preset chord that Cubase gives to another command is a listed difference, and every listed difference is real', () => {
  const missing: string[] = [];
  for (const binding of CUBASE_PRESET) {
    const rows = CUBASE_REFERENCE.filter((row) => row.chord === binding.chord);
    if (rows.length === 0) continue;
    if (rows.some((row) => row.commandId === binding.commandId)) continue;
    const listed = DIFFERENCES.some((d) => d.chord === binding.chord && d.commandId === binding.commandId && d.scope === binding.scope);
    if (!listed) missing.push(`${binding.scope} ${binding.chord} -> ${binding.commandId} (Cubase: ${rows.map((r) => r.command).join(', ')})`);
  }
  assert.deepEqual(missing, [], 'preset chords Cubase gives another command, not in DIFFERENCES');
  for (const d of DIFFERENCES) {
    assert.ok(CUBASE_PRESET.some((b) => b.chord === d.chord && b.commandId === d.commandId && b.scope === d.scope), `${d.chord}: not in the preset`);
    const rows = CUBASE_REFERENCE.filter((row) => row.chord === d.chord);
    assert.ok(rows.length > 0 && rows.every((row) => row.commandId !== d.commandId), `${d.chord}: Cubase gives no other command this chord`);
    assert.ok(rows.some((row) => row.command === d.cubase), `${d.chord}: Cubase's command is ${rows.map((r) => r.command).join(', ')}, not ${d.cubase}`);
    assert.ok(d.why.trim() !== '', `${d.chord}: why`);
  }
});

test('the differences are the locators on markers 1 and 2, F3, F6, Ctrl+P and Return', () => {
  assert.deepEqual(DIFFERENCES.map((d) => d.chord).sort(), ['Enter', 'F3', 'F6', 'Mod+1', 'Mod+2', 'Mod+P', 'Shift+1', 'Shift+2']);
});

// The keys section 7 of the research file writes, per subsection: the
// Windows column of its tables (the Key column where a table has no Windows
// column), and in a subsection without a table the backticked keys of the
// lines that start with one (7.9's sentence). Notes under a table are not keys.
export function researchKeys(markdown: string): Map<string, Set<string>> {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('## 7.'));
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## ') && !line.startsWith('## 7.'));
  const out = new Map<string, Set<string>>();
  let section: string | null = null;
  let column = -1;
  let hasTable = false;
  for (const line of lines.slice(start, end)) {
    const heading = /^### (7\.\d+)\b/.exec(line);
    if (heading) {
      section = heading[1]!;
      out.set(section, new Set());
      column = -1;
      hasTable = false;
      continue;
    }
    if (section === null) continue;
    const keys = out.get(section)!;
    if (line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      if (column === -1) {
        column = cells.findIndex((cell) => cell === 'Windows');
        if (column === -1) column = cells.findIndex((cell) => cell === 'Key');
        hasTable = true;
        continue;
      }
      if (/^-+$/.test(cells[0] ?? '')) continue;
      for (const match of (cells[column] ?? '').matchAll(/`([^`]+)`/g)) keys.add(match[1]!);
    } else {
      column = -1;
      if (!hasTable && line.startsWith('`')) for (const match of line.matchAll(/`([^`]+)`/g)) keys.add(match[1]!);
    }
  }
  return out;
}

test('the guard: the parser reads a table\'s Windows column and a sentence of keys, and nothing else', () => {
  const sample = [
    '## 7. Default key commands',
    'Still active: `Ctrl+S`, `Num *`.',
    '### 7.1 Transport',
    '| Command | Windows | Mac |',
    '|---|---|---|',
    '| Start | `Enter` (numpad) | same |',
    '| Rewind / Forward | `Num -` / `Num +` | `Cmd+...` |',
    '',
    'A note: `F2` is listed twice.',
    '### 7.3 Tools',
    '| Tool | Key |',
    '|---|---|',
    '| Split | `3` |',
    '### 7.9 File',
    '`Ctrl+N` new, `Ctrl+O` open.',
    '### 7.10 Things with no default key',
    'Sources: `B/key_commands/x.html`.',
    '## 8. Mouse',
    '| Command | Windows |',
    '| x | `Z` |',
  ].join('\n');
  const keys = researchKeys(sample);
  assert.deepEqual(
    [...keys].map(([section, set]) => [section, [...set]]),
    [
      ['7.1', ['Enter', 'Num -', 'Num +']],
      ['7.3', ['3']],
      ['7.9', ['Ctrl+N', 'Ctrl+O']],
      ['7.10', []],
    ],
  );
});

test('the guard: the transcription has exactly the keys section 7 of the research file writes, subsection by subsection', () => {
  const research = researchKeys(fs.readFileSync(RESEARCH, 'utf8'));
  const sections = [...research.keys()].filter((section) => research.get(section)!.size > 0);
  assert.deepEqual(sections, ['7.1', '7.2', '7.3', '7.4', '7.5', '7.6', '7.7', '7.8', '7.9']);
  let total = 0;
  for (const section of sections) {
    const written = [...research.get(section)!].sort();
    const transcribed = [...new Set(CUBASE_REFERENCE.filter((row) => row.section === section).map((row) => row.key))].sort();
    assert.deepEqual(transcribed, written, `section ${section}: the transcription's keys against the research file's`);
    total += written.length;
  }
  // Section 7 writes some two hundred keys; a parser that read none would pass the comparison above.
  assert.ok(total > 150, `only ${total} keys read`);
  assert.ok(CUBASE_REFERENCE.every((row) => sections.includes(row.section)), 'a row of a subsection the research does not have');
});
