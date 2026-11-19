import { useCallback, useRef, useState } from "react";
import type { AiSettings } from "./ai";

/** Minimal typing for the Web Speech API (not in every TS DOM lib). */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

async function transcribe(settings: AiSettings, audio: Blob): Promise<string> {
  const form = new FormData();
  const ext = audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm";
  form.append("file", audio, `question.${ext}`);
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription failed (${res.status})`);
  const body = (await res.json()) as { text?: string };
  return body.text?.trim() ?? "";
}

/**
 * Speak a question instead of typing it. Uses the browser's own speech
 * recognition when it has one; otherwise records audio and has OpenAI
 * transcribe it (needs the API key).
 */
export function useDictation(onText: (text: string) => void, settings: AiSettings | null) {
  const [listening, setListening] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);

  const stop = useCallback(() => {
    recRef.current?.stop();
    if (mediaRef.current && mediaRef.current.state !== "inactive") mediaRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const Ctor = recognitionCtor();
    if (Ctor) {
      const rec = new Ctor();
      rec.lang = navigator.language || "en-US";
      rec.interimResults = true;
      rec.continuous = false;
      rec.onresult = (e) => onText(Array.from(e.results, (r) => r[0]?.transcript ?? "").join(""));
      rec.onerror = (e) => setError(e.error === "not-allowed" ? "Microphone permission was denied." : `Voice input error: ${e.error}`);
      rec.onend = () => setListening(false);
      recRef.current = rec;
      setListening(true);
      rec.start();
      return;
    }
    if (!settings || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice input isn't available in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setListening(false);
        setWorking(true);
        try {
          onText(await transcribe(settings, new Blob(chunks, { type: rec.mimeType })));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setWorking(false);
        }
      };
      mediaRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setError("Microphone permission was denied.");
    }
  }, [onText, settings]);

  return { listening, working, error, start, stop };
}

/** Read an answer out loud (hands-free in the panel). */
export function speak(markdown: string): void {
  if (!("speechSynthesis" in window)) return;
  const text = markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*`>_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

export function stopSpeaking(): void {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}
