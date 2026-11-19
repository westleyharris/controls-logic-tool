import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark";
const KEY = "clt-theme";

function systemTheme(): ThemeChoice {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function stored(): ThemeChoice | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

/** Light/dark toggle. Follows the OS until the user picks one. */
export function useTheme(): [ThemeChoice, () => void] {
  const [theme, setTheme] = useState<ThemeChoice>(() => stored() ?? systemTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (stored()) return;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(systemTheme());
    mq?.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, []);

  const toggle = () => {
    const next: ThemeChoice = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // ignore
    }
    setTheme(next);
  };

  return [theme, toggle];
}
