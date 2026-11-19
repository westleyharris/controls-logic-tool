import { useState } from "react";
import { listModels, loadAiSettings, saveAiSettings } from "../lib/ai";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const current = loadAiSettings();
  const [apiKey, setApiKey] = useState(current?.apiKey ?? "");
  const [model, setModel] = useState(current?.model ?? "");
  const [models, setModels] = useState<string[]>(current?.model ? [current.model] : []);
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const check = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const list = await listModels(apiKey.trim());
      setModels(list);
      if (!list.includes(model)) setModel(list[0] ?? "");
      setStatus(`Key works — ${list.length} chat models available.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (apiKey.trim() && model) {
            saveAiSettings({ apiKey: apiKey.trim(), model });
            onClose();
          }
        }}
      >
        <h2 className="modal-title">Settings</h2>
        <h3 className="section-label">Ask AI (OpenAI)</h3>
        <p className="muted small">
          Your key is stored only in this browser. When you click an Ask AI button, the rung, routine or AOI you're looking
          at — its logic, comments and tag descriptions/values — is sent from this browser straight to OpenAI. Nothing is
          sent otherwise.
        </p>
        <label className="field">
          <span>API key</span>
          <div className="key-row">
            <input
              className="input"
              type={show ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button type="button" className="btn ghost small" onClick={() => setShow((x) => !x)}>
              {show ? "Hide" : "Show"}
            </button>
          </div>
        </label>
        <div className="key-row">
          <button type="button" className="btn small" disabled={!apiKey.trim() || checking} onClick={() => void check()}>
            {checking ? "Checking…" : "Check key & load models"}
          </button>
          {status ? <span className="small muted">{status}</span> : null}
        </div>
        <label className="field">
          <span>Model</span>
          {models.length > 1 ? (
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              placeholder="Check the key to pick a model, or type one (e.g. gpt-4o-mini)"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          )}
        </label>
        <div className="modal-actions">
          {current ? (
            <button
              type="button"
              className="btn ghost danger"
              onClick={() => {
                saveAiSettings(null);
                onClose();
              }}
            >
              Remove key
            </button>
          ) : null}
          <span className="topbar-spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!apiKey.trim() || !model}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
