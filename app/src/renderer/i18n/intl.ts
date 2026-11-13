// The grammar the catalogs cannot hold as plain strings (UI redesign spec
// 6.2): plurals through Intl.PluralRules (English has them, Chinese does not)
// and relative times through Intl.RelativeTimeFormat. Both take the locale
// explicitly, and the time helper takes "now" so tests can pin it.

import { htmlLang, type Locale } from './locale';

export type PluralForms = { readonly other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

export function plural(locale: Locale, count: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(htmlLang(locale)).select(count);
  return forms[category] ?? forms.other;
}

const UNITS: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', Number.POSITIVE_INFINITY],
];

// "30 seconds ago", "5 分鐘前": the largest unit below its next one.
export function relativeTime(thenMs: number, nowMs: number, locale: Locale): string {
  let value = (thenMs - nowMs) / 1000;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [name, next] of UNITS) {
    unit = name;
    if (Math.abs(value) < next) break;
    value /= next;
  }
  const rounded = Math.round(value);
  return new Intl.RelativeTimeFormat(htmlLang(locale), { numeric: 'auto' }).format(rounded === 0 ? 0 : rounded, unit);
}
