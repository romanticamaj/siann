// The UI locale (UI redesign spec 6.1): detection from the system language
// tags (navigator.languages in Electron and in a browser), the <html lang> of
// each locale, and a small external store the React chrome reads through
// useSyncExternalStore and the canvas surfaces subscribe to. A manual choice
// is kept per user under siann.locale and overrides detection; storage that
// is missing or throws (a private window, blocked site data) leaves detection
// alone and the switch working for the session.

// en, zh-Hant and zh-Hans are the user's choices; pseudo pads English by 40 %
// for the fit check and is accepted only under the test hooks.
export type Locale = 'en' | 'zh-Hant' | 'zh-Hans' | 'pseudo';
export const LOCALES = ['en', 'zh-Hant', 'zh-Hans'] as const;
export type UserLocale = (typeof LOCALES)[number];

// Each language named in its own script (endonyms are not translated).
export const LOCALE_NAMES: Readonly<Record<UserLocale, string>> = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
};

export const LOCALE_STORAGE_KEY = 'siann.locale';

// zh-TW, zh-HK, zh-MO and any zh-Hant-* give zh-Hant; zh-CN, zh-SG, any
// zh-Hans-* and bare zh give zh-Hans; everything else gives en. Only the first
// tag decides, as the user ordered them. Case-insensitive.
export function localeForTags(tags: readonly string[]): UserLocale {
  const first = tags[0];
  if (!first) return 'en';
  const parts = first.toLowerCase().split(/[-_]/);
  if (parts[0] !== 'zh') return 'en';
  if (parts.includes('hant')) return 'zh-Hant';
  if (parts.includes('hans')) return 'zh-Hans';
  const region = parts[1];
  return region === 'tw' || region === 'hk' || region === 'mo' ? 'zh-Hant' : 'zh-Hans';
}

// The document language: without zh-TW or zh-CN the system draws Han
// characters with one regional glyph set for all locales (spec 6.1).
export function htmlLang(locale: Locale): string {
  if (locale === 'zh-Hant') return 'zh-TW';
  if (locale === 'zh-Hans') return 'zh-CN';
  return 'en';
}

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocaleStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Locale;
  setLocale(locale: Locale): void;
}

export interface LocaleStoreOptions {
  // The system language tags, most preferred first.
  readonly languages: readonly string[];
  readonly storage: LocaleStorage | null;
  // Accept the pseudo-locale (SIANN_SHELL_TEST=1 only).
  readonly allowPseudo?: boolean;
}

function isUserLocale(value: unknown): value is UserLocale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export function createLocaleStore(options: LocaleStoreOptions): LocaleStore {
  const valid = (value: unknown): value is Locale => isUserLocale(value) || (options.allowPseudo === true && value === 'pseudo');
  let stored: string | null = null;
  try {
    stored = options.storage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  let current: Locale = valid(stored) ? stored : localeForTags(options.languages);
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => current,
    setLocale: (next) => {
      if (!valid(next)) throw new Error(`not a locale: ${String(next)}`);
      try {
        options.storage?.setItem(LOCALE_STORAGE_KEY, next);
      } catch {
        // Not kept past this session; the switch still applies.
      }
      if (next === current) return;
      current = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
