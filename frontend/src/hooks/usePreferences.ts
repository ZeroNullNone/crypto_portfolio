import { useCallback, useEffect, useState } from "react";

export interface Preferences {
  hideLowBalance: boolean;
  hideSensitiveNumbers: boolean;
  lowBalanceThreshold: number;
  lang: string;
}

const DEFAULTS: Preferences = {
  hideLowBalance: true,
  hideSensitiveNumbers: false,
  lowBalanceThreshold: 1,
  lang: "EN",
};

const STORAGE_KEY = "portfolio:prefs:v1";
const SUPPORTED_LANGS = ["EN", "ZH"] as const;
let scope: string | null = null;

function storageKey(): string {
  return scope ? `${STORAGE_KEY}:${scope}` : STORAGE_KEY;
}

function read(): Preferences {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    const merged = { ...DEFAULTS, ...parsed };
    if (!SUPPORTED_LANGS.includes(merged.lang as (typeof SUPPORTED_LANGS)[number])) {
      merged.lang = DEFAULTS.lang;
    }
    if (
      typeof merged.lowBalanceThreshold !== "number" ||
      !Number.isFinite(merged.lowBalanceThreshold) ||
      merged.lowBalanceThreshold < 0
    ) {
      merged.lowBalanceThreshold = DEFAULTS.lowBalanceThreshold;
    }
    return merged;
  } catch {
    return DEFAULTS;
  }
}

// Module-level singleton so every hook instance observes the same value and
// a change made in one component (e.g. the user menu) is reflected in another
// (e.g. the dashboard "hide low balance" toggle) without a round-trip through
// storage events.
let current = read();
const listeners = new Set<(p: Preferences) => void>();

function write(next: Preferences): void {
  current = next;
  try {
    localStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // ignore quota / private-mode failures
  }
  listeners.forEach((l) => l(next));
}

export function setPreferenceScope(userId: string | null): void {
  scope = userId;
  current = read();
  listeners.forEach((l) => l(current));
}

/** Read the current language outside React (e.g. from the API client at
 *  request time). The hook variant is preferred inside components — this
 *  exists so signup / password-reset / resend calls can tag themselves with
 *  the website language without threading a prop through every caller. */
export function getCurrentLang(): string {
  return current.lang;
}

export function isSensitiveNumbersHidden(): boolean {
  return current.hideSensitiveNumbers;
}

export function usePreferences(): {
  prefs: Preferences;
  setPref: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
} {
  const [prefs, setPrefs] = useState<Preferences>(current);

  useEffect(() => {
    listeners.add(setPrefs);
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);

  const setPref = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      write({ ...current, [key]: value });
    },
    [],
  );

  return { prefs, setPref };
}
