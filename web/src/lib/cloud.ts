import { useSyncExternalStore } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Optional cloud library (Supabase): sign in and your machines, export files,
 * drawings and notes follow you to every device. Without signing in the app
 * stays fully local. The publishable key is meant to be public; row-level
 * security limits every row and file to its owner.
 */
export const CLOUD_URL: string = import.meta.env.VITE_SUPABASE_URL ?? "https://kyzxfgvqoumkryvmbfqg.supabase.co";
export const CLOUD_KEY: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_Oq0d7bkCOxrWseCAMSCtNg_92LiSGC8";

let client: Promise<SupabaseClient> | null = null;

/** The Supabase client, loaded on first use. */
export function supabase(): Promise<SupabaseClient> {
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(CLOUD_URL, CLOUD_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "clt-auth" },
    }),
  );
  return client;
}

/* ------------------------------- shared state ------------------------------- */

export interface CloudState {
  /** Session restored (or known absent). */
  ready: boolean;
  user: { id: string; email: string } | null;
  syncing: boolean;
  lastSync?: number;
  error?: string;
  /** Short progress line while syncing. */
  progress?: string;
}

let state: CloudState = { ready: false, user: null, syncing: false };
const listeners = new Set<() => void>();

export function getCloudState(): CloudState {
  return state;
}

export function setCloudState(patch: Partial<CloudState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useCloud(): CloudState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Restore the session and follow sign-in / sign-out. */
export async function startAuth(onSignedIn: () => void): Promise<void> {
  try {
    const sb = await supabase();
    const { data } = await sb.auth.getSession();
    const u = data.session?.user;
    setCloudState({ ready: true, user: u ? { id: u.id, email: u.email ?? "" } : null });
    if (u) onSignedIn();
    sb.auth.onAuthStateChange((event, session) => {
      const next = session?.user ? { id: session.user.id, email: session.user.email ?? "" } : null;
      const was = state.user?.id;
      setCloudState({ user: next });
      if (next && next.id !== was && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) onSignedIn();
    });
  } catch (err) {
    // Offline at startup or the client failed to load: the app works locally.
    setCloudState({ ready: true, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const sb = await supabase();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/** Returns true when the account needs its email confirmed first. */
export async function signUp(email: string, password: string): Promise<boolean> {
  const sb = await supabase();
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
  if (error) throw new Error(error.message);
  return !data.session;
}

export async function sendPasswordReset(email: string): Promise<void> {
  const sb = await supabase();
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  const sb = await supabase();
  await sb.auth.signOut();
  setCloudState({ user: null, lastSync: undefined });
}
