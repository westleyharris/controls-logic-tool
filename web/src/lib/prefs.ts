import { useCallback, useState } from "react";

/** Ladder display options, remembered in this browser. */
export interface LadderPrefs {
  /** Show address/tag descriptions above instructions. */
  descriptions: boolean;
  /** Highlight instructions that were ON in the saved values and show values in blocks. */
  values: boolean;
  /** PLC-5: show the symbol (from the .SY6) instead of the raw address when there is one. */
  symbols: boolean;
  /** Tighter spacing. */
  compact: boolean;
}

const KEY = "clt-ladder-prefs";
const DEFAULTS: LadderPrefs = { descriptions: true, values: true, symbols: false, compact: false };

function load(): LadderPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<LadderPrefs>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function useLadderPrefs(): [LadderPrefs, (patch: Partial<LadderPrefs>) => void] {
  const [prefs, setPrefs] = useState<LadderPrefs>(load);
  const update = useCallback((patch: Partial<LadderPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);
  return [prefs, update];
}

/** A number remembered in localStorage (pane widths). */
export function useStoredNumber(key: string, initial: number): [number, (n: number) => void] {
  const [value, setValue] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(key);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (n: number) => {
      setValue(n);
      try {
        localStorage.setItem(key, String(Math.round(n)));
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [value, set];
}
