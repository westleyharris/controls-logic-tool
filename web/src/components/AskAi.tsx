import { useEffect, useRef, useState } from "react";
import { chat, openAiSettings, SYSTEM_PROMPT, useAiSettings, type ChatMessage } from "../lib/ai";
import { Markdown } from "./Markdown";

/** Conversations kept for this session, so switching views doesn't lose an answer. */
const conversations = new Map<string, ChatMessage[]>();

export function AskAi({
  cacheKey,
  label,
  what,
  buildContext,
}: {
  /** Identifies the thing being explained (rung, routine, AOI, tag). */
  cacheKey: string;
  label: string;
  /** Shown in the privacy note: what gets sent. */
  what: string;
  buildContext: () => string;
}) {
  const settings = useAiSettings();
  const [messages, setMessages] = useState<ChatMessage[]>(() => conversations.get(cacheKey) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (next: ChatMessage[]) => {
    if (!settings) return;
    setBusy(true);
    setError(null);
    setMessages(next);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const answer = await chat(settings, next, ctrl.signal);
      const done: ChatMessage[] = [...next, { role: "assistant", content: answer }];
      conversations.set(cacheKey, done);
      setMessages(done);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    void send([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildContext() },
    ]);

  if (!settings) {
    return (
      <div className="ai-box">
        <p className="muted small">Add your OpenAI API key in Settings to get an AI explanation here.</p>
        <button type="button" className="btn small" onClick={openAiSettings}>
          Open Settings
        </button>
      </div>
    );
  }

  const visible = messages.filter((m) => m.role !== "system");
  return (
    <div className="ai-box">
      {visible.length === 0 ? (
        <>
          <button type="button" className="btn primary small" disabled={busy} onClick={start}>
            {busy ? "Asking…" : label}
          </button>
          <p className="muted small ai-note">
            Sends {what} to OpenAI ({settings.model}).
          </p>
        </>
      ) : (
        <div className="ai-thread">
          {visible.slice(1).map((m, i) =>
            m.role === "assistant" ? (
              <div key={i} className="ai-answer">
                <Markdown text={m.content} />
              </div>
            ) : (
              <div key={i} className="ai-question">
                {m.content}
              </div>
            ),
          )}
          {busy ? (
            <div className="ai-answer muted">
              <span className="spinner" aria-hidden /> Thinking…
            </div>
          ) : null}
          <form
            className="ai-followup"
            onSubmit={(e) => {
              e.preventDefault();
              const q = followUp.trim();
              if (!q || busy) return;
              setFollowUp("");
              void send([...messages, { role: "user", content: q }]);
            }}
          >
            <input
              className="input small"
              placeholder="Ask a follow-up…"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
            />
            <button type="submit" className="btn small" disabled={busy || !followUp.trim()}>
              Ask
            </button>
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() => {
                conversations.delete(cacheKey);
                setMessages([]);
              }}
            >
              Clear
            </button>
          </form>
        </div>
      )}
      {error ? <div className="notice error small">{error}</div> : null}
    </div>
  );
}
