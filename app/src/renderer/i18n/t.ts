// t(key, params) over the catalogs (UI redesign spec 6.2): translator(locale)
// for code that knows its locale (the canvas surfaces, message builders,
// tests), and useT() for React, which reads the installed locale store
// through useSyncExternalStore so a switch re-renders the chrome live.

import { useSyncExternalStore } from 'react';

import { en, type Catalog, type MessageKey } from './en';
import type { Locale, LocaleStore } from './locale';
import { pseudoCatalog } from './pseudo';
import { zhHans } from './zh-Hans';
import { zhHant } from './zh-Hant';

export { plural, relativeTime } from './intl';
export type { MessageKey } from './en';

type Params<K extends MessageKey> = Catalog[K] extends (params: infer P) => string
  ? [params: P]
  : [params?: Readonly<Record<string, string | number>>];

export type T = <K extends MessageKey>(key: K, ...params: Params<K>) => string;

let pseudo: Catalog | null = null;

export function catalogFor(locale: Locale): Catalog {
  switch (locale) {
    case 'zh-Hant':
      return zhHant;
    case 'zh-Hans':
      return zhHans;
    case 'pseudo':
      pseudo ??= pseudoCatalog(en);
      return pseudo;
    case 'en':
      return en;
  }
}

// {name} replaced by params.name; a placeholder without a value stays as is.
export function interpolate(template: string, params: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

const translators = new Map<Locale, T>();

export function translator(locale: Locale): T {
  let t = translators.get(locale);
  if (!t) {
    const catalog = catalogFor(locale);
    t = ((key: MessageKey, params?: unknown) => {
      const message = catalog[key] as unknown;
      if (typeof message === 'function') return (message as (p: unknown) => string)(params);
      return interpolate(String(message), params as Record<string, string | number> | undefined);
    }) as T;
    translators.set(locale, t);
  }
  return t;
}

// The store React reads; English until index.tsx installs the real one.
const fixed: LocaleStore = {
  subscribe: () => () => {},
  getSnapshot: () => 'en',
  setLocale: () => {
    throw new Error('no locale store installed');
  },
};
let active: LocaleStore = fixed;

export function installLocaleStore(store: LocaleStore): void {
  active = store;
}

export function localeStore(): LocaleStore {
  return active;
}

export function useLocale(): Locale {
  const store = active;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useT(): T {
  return translator(useLocale());
}
