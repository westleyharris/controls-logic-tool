import { useCallback, useEffect, useState } from "react";

/**
 * Small notes you write down (message → machine links, spare-part notes,
 * alarm notes), kept per "scope" in localStorage with a timestamp on every
 * entry so they can sync between devices: the newest write wins, and a
 * deleted entry stays as a tombstone (value null) until it has synced.
 */

export interface KvEntry {
  v: unknown;
  /** Last change, ms since epoch. */
  t: number;
}

const PREFIX = "clt-kv:";
export const KV_EVENT = "clt-kv-change";

/** Formats used before notes could sync. */
function legacyKey(scope: string): string | undefined {
  if (scope === "links") return "clt-endpoint-links";
  if (scope === "parts") return "clt-parts-notes";
  if (scope.startsWith("alarm:")) return `clt-alarm-notes:${scope.slice(6)}`;
  return undefined;
}

export function kvEntries(scope: string): Record<string, KvEntry> {
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (raw) return JSON.parse(raw) as Record<string, KvEntry>;
    const legacy = legacyKey(scope);
    const old = legacy ? localStorage.getItem(legacy) : null;
    if (old) {
      const plain = JSON.parse(old) as Record<string, unknown>;
      const now = Date.now();
      const entries = Object.fromEntries(Object.entries(plain).map(([k, v]) => [k, { v, t: now }]));
      localStorage.setItem(PREFIX + scope, JSON.stringify(entries));
      return entries;
    }
  } catch {
    // unreadable — start empty
  }
  return {};
}

function write(scope: string, entries: Record<string, KvEntry>) {
  try {
    localStorage.setItem(PREFIX + scope, JSON.stringify(entries));
  } catch {
    // storage full / blocked
  }
  window.dispatchEvent(new CustomEvent(KV_EVENT, { detail: scope }));
}

/** Live values (tombstones left out). */
export function kvAll<T>(scope: string): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, e] of Object.entries(kvEntries(scope))) if (e.v !== null && e.v !== undefined) out[k] = e.v as T;
  return out;
}

export function kvSet(scope: string, key: string, value: unknown): void {
  const entries = kvEntries(scope);
  entries[key] = { v: value ?? null, t: Date.now() };
  write(scope, entries);
  onLocalChange?.(scope);
}

/** Every scope stored on this device. */
export function kvScopes(): string[] {
  const out = new Set<string>(["links", "parts"]);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) out.add(k.slice(PREFIX.length));
      else if (k?.startsWith("clt-alarm-notes:")) out.add(`alarm:${k.slice("clt-alarm-notes:".length)}`);
    }
  } catch {
    // ignore
  }
  return [...out];
}

/** Take remote entries that are newer than ours. Returns true if anything changed. */
export function kvMerge(scope: string, remote: Record<string, KvEntry>): boolean {
  const entries = kvEntries(scope);
  let changed = false;
  for (const [k, r] of Object.entries(remote)) {
    const mine = entries[k];
    if (!mine || r.t > mine.t) {
      entries[k] = r;
      changed = true;
    }
  }
  if (changed) write(scope, entries);
  return changed;
}

export function kvDrop(scope: string): void {
  try {
    localStorage.removeItem(PREFIX + scope);
  } catch {
    // ignore
  }
}

/** Set by the sync layer so a local edit gets pushed soon after. */
let onLocalChange: ((scope: string) => void) | undefined;
export function setKvListener(fn: ((scope: string) => void) | undefined): void {
  onLocalChange = fn;
}


/** Live values of one scope; re-reads when another tab or a sync changes it. */
export function useKv<T>(scope: string): [Record<string, T>, (key: string, value: T | null) => void] {
  const [values, setValues] = useState<Record<string, T>>(() => kvAll<T>(scope));
  useEffect(() => {
    setValues(kvAll<T>(scope));
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === scope) setValues(kvAll<T>(scope));
    };
    window.addEventListener(KV_EVENT, on);
    return () => window.removeEventListener(KV_EVENT, on);
  }, [scope]);
  const set = useCallback((key: string, value: T | null) => kvSet(scope, key, value), [scope]);
  return [values, set];
}
