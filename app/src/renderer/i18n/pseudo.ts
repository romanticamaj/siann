// The pseudo-locale of the fit check (UI redesign spec 6.3): every English
// message padded by at least 40 % and bracketed, placeholders kept, so a
// layout that only fits English shows up before a translation does. Derived
// from the English catalog at runtime; not a fourth catalog file, and
// reachable only under the test hooks.

import type { Catalog } from './en';

export function pseudoText(text: string): string {
  const pad = Math.max(1, Math.ceil(text.length * 0.4));
  return `[${text}${'~'.repeat(pad)}]`;
}

export function pseudoCatalog(base: Catalog): Catalog {
  const out: Record<string, unknown> = {};
  for (const [key, message] of Object.entries(base) as Array<[string, unknown]>) {
    if (typeof message === 'function') {
      const fn = message as (params: unknown) => string;
      out[key] = (params: unknown) => pseudoText(fn(params));
    } else {
      out[key] = pseudoText(String(message));
    }
  }
  return out as Catalog;
}
