// The text an agent writes in the mockup's session (m5b-ui-plan-metadata; UI
// redesign 10.7, 3): the plans' titles, the pending plan's intent and the
// rejection note. The app never translates an agent's text, so the fidelity
// session submits, for each locale, the words the mockup draws in that locale
// (its L(): the ZH table for zh, else the English), and the zh-TW window shows
// 提升副歌 and 收緊低頻 beside a mockup that draws them. Pure: it takes
// mockup.html's source, so the unit build (dist/) and the e2e run read the
// same table.

import { zhHant } from '../../../src/renderer/i18n/zh-Hant';

export interface SessionText {
  readonly titles: { readonly stale: string; readonly rejected: string; readonly applied: string; readonly plan: string };
  readonly intent: string;
  readonly note: string;
}

// The mockup's English, as its template writes it.
export const EN_TEXT: SessionText = {
  titles: { stale: 'Trim silence on drums', rejected: 'Double the lead vocal', applied: 'Tame the low end', plan: 'Lift the chorus' },
  intent: 'Add a pad under the chorus, bring the backing vocals forward and land the riser on the downbeat of bar 9.',
  note: 'Too wide for the verse — keep it mono.',
};
// The mockup's rejected row wraps the note in its own words.
export const EN_REJECTED_ROW = `“${EN_TEXT.note}” · sent to agent`;

// mockup.html's ZH table, evaluated from its source.
export function mockupZhTable(mockupHtml: string): Record<string, string> {
  const source = mockupHtml.replace(/\r\n/g, '\n');
  const at = source.indexOf('const ZH={');
  const end = source.indexOf('\n};', at);
  if (at < 0 || end < 0) throw new Error('mockup.html has no ZH table');
  return new Function(`return ${source.slice(at + 'const ZH='.length, end + 2)};`)() as Record<string, string>;
}

// What the mockup draws for the session's agent text in `locale` (a key of
// the manifest's locales: en, zh-TW). The note is the zh row with the app's
// own words around it (history.rejected) taken off, so the app's row reads
// the mockup's.
export function sessionText(locale: string, mockupHtml: string): SessionText {
  if (!locale.startsWith('zh')) return EN_TEXT;
  const zh = mockupZhTable(mockupHtml);
  const L = (s: string): string => {
    const value = zh[s];
    if (value === undefined) throw new Error(`mockup.html's ZH table has no "${s}"`);
    return value;
  };
  const row = L(EN_REJECTED_ROW);
  const [before, after] = zhHant['history.rejected'].split('{note}') as [string, string];
  if (!row.startsWith(before) || !row.endsWith(after)) throw new Error(`the mockup's rejected row "${row}" is not the app's "${zhHant['history.rejected']}"`);
  return {
    titles: { stale: L(EN_TEXT.titles.stale), rejected: L(EN_TEXT.titles.rejected), applied: L(EN_TEXT.titles.applied), plan: L(EN_TEXT.titles.plan) },
    intent: L(EN_TEXT.intent),
    note: row.slice(before.length, row.length - after.length),
  };
}
