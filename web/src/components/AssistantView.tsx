import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectIndex } from "@core/query/index";
import { openAiSettings, useAiSettings } from "../lib/ai";
import { agentSystemPrompt, runAgent, searchSignals, type AgentMessage, type AgentStep, type ContentPart } from "../lib/agent";
import type { Attachment } from "../lib/machines";
import { imageToDataUrl } from "../lib/pdf";
import { speak, stopSpeaking, useDictation } from "../lib/voice";
import { FilePicker } from "./FilePicker";
import type { Location, Selection } from "../lib/nav";
import { Markdown } from "./Markdown";

interface Turn {
  question: string;
  /** Photos attached to the question (data URLs). */
  photos?: string[];
  steps: AgentStep[];
  answer?: string;
  error?: string;
  /** Without an API key: signals matching the words in the question. */
  matches?: ReturnType<typeof searchSignals>;
}

interface Conversation {
  messages: AgentMessage[];
  turns: Turn[];
}

/** Keep image data out of the running history once a turn is answered (they'd be re-sent every time). */
function stripImages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((m) =>
    m.role === "user" && Array.isArray(m.content)
      ? {
          role: "user",
          content: m.content.map((p): ContentPart => (p.type === "image_url" ? { type: "text", text: "[image shown earlier]" } : p)),
        }
      : m,
  );
}

/** Conversations per machine, kept for this browser session. */
const conversations = new Map<string, Conversation>();

const EXAMPLES = [
  "Which alarms or faults were active when this was saved?",
  "The main drive won't start — what's stopping it?",
  "What should I check first on this machine?",
];

export function AssistantView({
  index,
  machineKey,
  attachments,
  onNavigate,
  onSelect,
}: {
  index: ProjectIndex;
  machineKey: string;
  attachments: Attachment[];
  onNavigate: (loc: Location) => void;
  onSelect: (sel: Selection) => void;
}) {
  const settings = useAiSettings();
  const [convo, setConvo] = useState<Conversation>(
    () => conversations.get(machineKey) ?? { messages: [{ role: "system", content: agentSystemPrompt(index, attachments) }], turns: [] },
  );
  const [input, setInput] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [speakAnswers, setSpeakAnswers] = useState(false);
  const dictation = useDictation(useCallback((text: string) => setInput(text), []), settings);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    conversations.set(machineKey, convo);
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [convo, machineKey]);

  const updateLast = (fn: (t: Turn) => Turn) =>
    setConvo((c) => ({ ...c, turns: c.turns.map((t, i) => (i === c.turns.length - 1 ? fn(t) : t)) }));

  const send = async (question: string) => {
    const q = question.trim() || (photos.length ? "What is this, and where is it in the program?" : "");
    if (!q || busy) return;
    setInput("");
    const attached = photos;
    setPhotos([]);
    dictation.stop();
    if (!settings) {
      setConvo((c) => ({ ...c, turns: [...c.turns, { question: q, steps: [], matches: searchSignals(index, q, 12) }] }));
      return;
    }
    const content: string | ContentPart[] = attached.length
      ? [{ type: "text", text: q }, ...attached.map((url): ContentPart => ({ type: "image_url", image_url: { url, detail: "high" } }))]
      : q;
    const history: AgentMessage[] = [...convo.messages, { role: "user", content }];
    setConvo((c) => ({ ...c, turns: [...c.turns, { question: q, steps: [], ...(attached.length ? { photos: attached } : {}) }] }));
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const added = await runAgent(
        settings,
        index,
        history,
        (step) => updateLast((t) => ({ ...t, steps: [...t.steps, step] })),
        ctrl.signal,
        { attachments },
      );
      const last = [...added].reverse().find((m) => m.role === "assistant" && m.content);
      if (speakAnswers && typeof last?.content === "string") speak(last.content);
      setConvo((c) => ({
        messages: stripImages([...history, ...added]),
        turns: c.turns.map((t, i) => (i === c.turns.length - 1 ? { ...t, answer: (last?.content as string) ?? "(no answer)" } : t)),
      }));
    } catch (err) {
      const stopped = (err as Error).name === "AbortError";
      updateLast((t) => ({ ...t, error: stopped ? "Stopped." : err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const onLink = (href: string) => {
    if (href.startsWith("rung:")) {
      const parts = href.slice(5).split("/");
      const rung = Number(parts.pop());
      const routineName = parts.pop() ?? "";
      const programName = parts.join("/") || routineName;
      const program =
        index.program(programName) ??
        index.project.programs.find((p) => p.name.toLowerCase() === programName.toLowerCase()) ??
        index.project.programs.find((p) => p.name.toLowerCase() === routineName.toLowerCase());
      if (!program || !Number.isFinite(rung)) return;
      const routine =
        program.routines.find((r) => r.name.toLowerCase() === routineName.toLowerCase()) ?? program.routines.find((r) => r.name === program.mainRoutine) ?? program.routines[0];
      if (!routine) return;
      const where = { kind: "program" as const, owner: program.name, routine: routine.name };
      onNavigate({ view: "routine", ref: where, rung });
      onSelect({ kind: "rung", where, rung });
      return;
    }
    if (href.startsWith("tag:")) {
      const rest = href.slice(4);
      const at = rest.lastIndexOf("@");
      const ref = at > 0 ? rest.slice(0, at) : rest;
      const owner = at > 0 ? rest.slice(at + 1) : (index.project.programs[0]?.name ?? "");
      onSelect({ kind: "ref", ref, where: { kind: "program", owner, routine: "" } });
    }
  };

  return (
    <div className="view assistant">
      <header className="view-head">
        <div className="eyebrow">Ask AI</div>
        <div className="view-title-row">
          <h1 className="view-title">Describe the problem</h1>
          {convo.turns.length ? (
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={() => setConvo({ messages: [{ role: "system", content: agentSystemPrompt(index) }], turns: [] })}
            >
              New conversation
            </button>
          ) : null}
        </div>
        <p className="view-desc">
          Say what the machine is doing in your own words — e.g. “the seamer brake is on, why won&apos;t it turn off?”. The assistant
          searches this program, traces the signals and links you to the rungs that matter.
        </p>
      </header>

      {!settings ? (
        <div className="notice">
          Ask AI needs your OpenAI API key.{" "}
          <button type="button" className="link" onClick={openAiSettings}>
            Open Settings
          </button>{" "}
          — until then, questions here just find matching signals for you to trace.
        </div>
      ) : null}

      <div className="thread">
        {convo.turns.length === 0 ? (
          <div className="examples">
            {EXAMPLES.map((e) => (
              <button key={e} type="button" className="example" onClick={() => void send(e)}>
                {e}
              </button>
            ))}
          </div>
        ) : null}
        {convo.turns.map((t, i) => (
          <div key={i} className="turn">
            <div className="ai-question">
              {t.photos?.length ? (
                <div className="q-photos">
                  {t.photos.map((p, k) => (
                    <img key={k} src={p} alt="Attached photo" />
                  ))}
                </div>
              ) : null}
              {t.question}
            </div>
            {t.steps.length ? (
              <details className="steps" open={!t.answer && !t.error}>
                <summary className="small muted">
                  {t.answer || t.error ? `Looked at ${t.steps.length} thing${t.steps.length === 1 ? "" : "s"}` : "Working…"}
                </summary>
                <ol>
                  {t.steps.map((s, k) => (
                    <li key={k} className="small">
                      {s.label}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            {t.answer ? (
              <div className="ai-answer">
                <Markdown text={t.answer} onLink={onLink} />
                <button type="button" className="link small read-aloud" onClick={() => speak(t.answer!)} title="Read this answer out loud">
                  🔊 Read aloud
                </button>
              </div>
            ) : null}
            {t.matches ? (
              <div className="ai-answer">
                <div className="md">
                  <p>{t.matches.length ? "Signals that match your words — click Why? to trace one:" : "No signals match those words. Try other wording or an address."}</p>
                  <ul className="match-list">
                    {t.matches.map((m) => (
                      <li key={`${m.ref}|${m.program}`}>
                        <span className={`bool small ${m.value === "1" ? "on" : "off"}`}>{m.value === "1" ? "ON" : m.value === "0" ? "OFF" : m.value}</span>
                        <span className="mono">{m.name}</span>
                        <span className="muted small">{m.description}</span>
                        <button
                          type="button"
                          className="link small"
                          onClick={() => onNavigate({ view: "troubleshoot", ref: m.ref, where: { kind: "program", owner: m.program } })}
                        >
                          Why?
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
            {!t.answer && !t.error && !t.matches && busy && i === convo.turns.length - 1 ? (
              <div className="ai-answer muted">
                <span className="spinner" aria-hidden /> Looking through the program…
              </div>
            ) : null}
            {t.error ? <div className="notice error small">{t.error}</div> : null}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        {photos.length ? (
          <div className="pending-photos">
            {photos.map((p, k) => (
              <span key={k} className="pending-photo">
                <img src={p} alt="Photo to send" />
                <button type="button" aria-label="Remove photo" onClick={() => setPhotos((ps) => ps.filter((_, i) => i !== k))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          className="input"
          rows={2}
          placeholder={
            dictation.listening ? "Listening… speak your question" : "e.g. The seamer brake is on — show me what the problem is and why it won't turn off"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="composer-actions">
          <FilePicker
            className="icon-btn big"
            accept="image/*"
            multiple={false}
            capture="environment"
            title="Take or attach a photo (HMI screen, wire label, terminal strip…)"
            onFiles={(files) => {
              const f = files[0];
              if (f) void imageToDataUrl(f).then((url) => setPhotos((ps) => [...ps, url].slice(-3)));
            }}
          >
            📷
          </FilePicker>
          <button
            type="button"
            className={`icon-btn big ${dictation.listening ? "recording" : ""}`}
            title={dictation.listening ? "Stop listening" : "Ask by voice"}
            aria-label={dictation.listening ? "Stop listening" : "Ask by voice"}
            disabled={dictation.working}
            onClick={() => (dictation.listening ? dictation.stop() : void dictation.start())}
          >
            {dictation.working ? "…" : "🎤"}
          </button>
          <button
            type="button"
            className={`icon-btn big ${speakAnswers ? "active" : ""}`}
            title={speakAnswers ? "Answers are read aloud — click to turn off" : "Read answers aloud automatically"}
            aria-pressed={speakAnswers}
            onClick={() => {
              if (speakAnswers) stopSpeaking();
              setSpeakAnswers((x) => !x);
            }}
          >
            🔊
          </button>
          {busy ? (
            <button type="button" className="btn ghost small" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          ) : null}
          <button type="submit" className="btn primary" disabled={busy || (!input.trim() && !photos.length)}>
            {busy ? "Working…" : "Ask"}
          </button>
        </div>
        {dictation.error ? <p className="small composer-note error-text">{dictation.error}</p> : null}
        {!settings && photos.length ? <p className="small composer-note error-text">Reading photos needs your OpenAI key (Settings).</p> : null}
        {settings ? (
          <p className="muted small composer-note">
            Sends your question and the signals/rungs the assistant looks up (with their descriptions and saved values) to OpenAI ({settings.model}).
          </p>
        ) : null}
      </form>
    </div>
  );
}
