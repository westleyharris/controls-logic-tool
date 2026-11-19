import { useState } from "react";
import { sendPasswordReset, signIn, signOut, signUp, useCloud } from "../lib/cloud";
import { syncNow } from "../lib/sync";

function ago(ts?: number): string {
  if (!ts) return "not yet";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(ts).toLocaleString();
}

/** Top-bar button: cloud status at a glance. */
export function CloudButton({ onClick }: { onClick: () => void }) {
  const c = useCloud();
  const title = !c.user
    ? "Sign in to sync your machines between devices"
    : c.syncing
      ? c.progress ?? "Syncing…"
      : c.error
        ? `Sync problem: ${c.error}`
        : `Synced ${ago(c.lastSync)} · ${c.user.email}`;
  return (
    <button type="button" className={`icon-btn cloud-btn ${c.user ? "on" : ""} ${c.syncing ? "busy" : ""} ${c.error ? "err" : ""}`} onClick={onClick} title={title} aria-label={title}>
      ☁
      {c.user ? <span className="cloud-dot" aria-hidden /> : null}
    </button>
  );
}

export function AccountDialog({ onClose, onSignedOut }: { onClose: () => void; onSignedOut: () => void }) {
  const c = useCloud();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!c.user) void run(() => signIn(email.trim(), password));
        }}
      >
        <h2 className="modal-title">{c.user ? "Your cloud library" : "Sync between devices"}</h2>
        {c.user ? (
          <>
            <p className="small">
              Signed in as <strong>{c.user.email}</strong>.
            </p>
            <p className="muted small">
              Machines (with their export files), drawings, alarm notes, spare-part notes and machine links sync to your account. Exports download to a device the
              first time you open them there. Your OpenAI key stays on each device.
            </p>
            <div className="sync-status small">
              {c.syncing ? (
                <>
                  <span className="spinner small" aria-hidden /> {c.progress ?? "Syncing…"}
                </>
              ) : c.error ? (
                <span className="error-text">Last sync failed: {c.error}</span>
              ) : (
                <>Last synced {ago(c.lastSync)}.</>
              )}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await signOut();
                    onSignedOut();
                    onClose();
                  })
                }
              >
                Sign out
              </button>
              <button type="button" className="btn" disabled={c.syncing} onClick={() => void syncNow()}>
                Sync now
              </button>
              <button type="button" className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              Sign in and the machines in this browser are copied to your account, so they show up on your phone and any other computer you sign in on. Without an
              account everything stays on this device.
            </p>
            <label className="field">
              <span>Email</span>
              <input className="input" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
              />
            </label>
            {error ? <p className="error-text small">{error}</p> : null}
            {message ? <p className="notice small">{message}</p> : null}
            <div className="modal-actions wrap">
              <button
                type="button"
                className="link small"
                disabled={busy || !email.trim()}
                onClick={() =>
                  void run(async () => {
                    await sendPasswordReset(email.trim());
                    setMessage(`Password reset link sent to ${email.trim()}.`);
                  })
                }
              >
                Forgot password?
              </button>
              <span className="topbar-spacer" />
              <button
                type="button"
                className="btn"
                disabled={busy || !email.trim() || password.length < 6}
                onClick={() =>
                  void run(async () => {
                    const confirm = await signUp(email.trim(), password);
                    if (confirm) setMessage(`Check ${email.trim()} for a confirmation link, then sign in here.`);
                  })
                }
              >
                Create account
              </button>
              <button type="submit" className="btn primary" disabled={busy}>
                {busy ? "…" : "Sign in"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
