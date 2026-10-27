/**
 * Minimal dictionary-based i18n: no runtime dependencies, typed keys, and the
 * choice persisted in `localStorage`. English is the source language and the
 * fallback for any key a translation might miss.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { en, type MessageKey } from "./en";
import { ru } from "./ru";

export type { MessageKey };

export type Locale = "en" | "ru";

export type Translate = (
  key: MessageKey,
  params?: Record<string, string | number>,
) => string;

type Messages = Record<MessageKey, string>;

const dictionaries: Record<Locale, Messages> = { en, ru };

// `label` is the language's own name, so the list stays readable in any locale.
export const LOCALES: { id: Locale; label: string; intl: string }[] = [
  { id: "en", label: "English", intl: "en-US" },
  { id: "ru", label: "Русский", intl: "ru-RU" },
];

export const DEFAULT_LOCALE: Locale = "en";

const STORAGE_KEY = "omni-chat.locale";

function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ru";
}

function loadLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

function interpolate(template: string, params?: Record<string, string | number>) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
  /** BCP 47 tag of the active locale, for `toLocaleString` and friends. */
  intlLocale: string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable in private contexts; the session keeps the value.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      intlLocale: LOCALES.find((entry) => entry.id === locale)?.intl ?? "en-US",
      t: (key, params) => interpolate(dictionaries[locale][key] ?? en[key] ?? key, params),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside <I18nProvider>");
  }
  return context;
}
