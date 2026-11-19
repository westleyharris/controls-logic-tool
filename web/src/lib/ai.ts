import { useEffect, useState } from "react";
import type { Routine, Rung, AoiDefinition } from "@core/model/types";
import { instructionsOf } from "@core/ladder/parse";
import { isTagOperand } from "@core/logic/refs";
import type { RungEvaluation } from "@core/logic/evaluate";
import { formatValue, type ProjectIndex, type Scope } from "@core/query/index";
import { describeBlocker, summarizeRung } from "./explain";
import type { Blocker } from "@core/logic/evaluate";

/**
 * "Ask AI" via the OpenAI API, using the user's own key. The key lives in this
 * browser's localStorage; requests go straight from the browser to OpenAI and
 * only when the user clicks.
 */

export interface AiSettings {
  apiKey: string;
  model: string;
}

const KEY = "clt-openai";
const PREFERRED_MODELS = ["gpt-5-mini", "gpt-5", "gpt-4.1-mini", "gpt-4.1", "gpt-4o-mini", "gpt-4o"];

export function loadAiSettings(): AiSettings | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<AiSettings>;
    return s.apiKey ? { apiKey: s.apiKey, model: s.model || PREFERRED_MODELS[0]! } : null;
  } catch {
    return null;
  }
}

export function saveAiSettings(s: AiSettings | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new Event("clt-ai-settings"));
}

/** Current AI settings; updates when they're saved anywhere in the app. */
export function useAiSettings(): AiSettings | null {
  const [settings, setSettings] = useState<AiSettings | null>(loadAiSettings);
  useEffect(() => {
    const onChange = () => setSettings(loadAiSettings());
    window.addEventListener("clt-ai-settings", onChange);
    return () => window.removeEventListener("clt-ai-settings", onChange);
  }, []);
  return settings;
}

/** Ask the app shell to open the Settings dialog. */
export function openAiSettings(): void {
  window.dispatchEvent(new Event("clt-open-settings"));
}

async function openaiError(res: Response): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) detail = body.error.message;
  } catch {
    // keep status text
  }
  if (res.status === 401) return new Error(`OpenAI rejected the API key (${detail}). Check it in Settings.`);
  return new Error(`OpenAI error: ${detail}`);
}

/** Chat-capable models on this key, best guesses first. */
export async function listModels(apiKey: string): Promise<string[]> {
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw await openaiError(res);
  const body = (await res.json()) as { data: { id: string }[] };
  const ids = body.data
    .map((m) => m.id)
    .filter((id) => /^(gpt-|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id));
  const rank = (id: string) => {
    const i = PREFERRED_MODELS.indexOf(id);
    return i >= 0 ? i : PREFERRED_MODELS.length;
  };
  return ids.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(settings: AiSettings, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: settings.model, messages }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await openaiError(res);
  const body = (await res.json()) as { choices: { message: { content: string } }[] };
  return body.choices[0]?.message.content?.trim() || "(empty answer)";
}

export const SYSTEM_PROMPT = `You are a senior Allen-Bradley controls engineer (RSLogix 5 / Studio 5000) helping a plant maintenance technician understand and troubleshoot PLC logic.
- Explain in plain language first, then the details. Name tags/addresses together with their descriptions.
- Values you are given were saved in the export file. They are a snapshot, not live readings — say so when it matters.
- When something is OFF or blocked, say which condition is blocking it and what physical thing on the machine to check (sensor, push button, guard, drive, interlock, HMI setting).
- Don't invent tags or behaviour that isn't in the logic. If something is ambiguous, say what you'd check.
- Use short headings and bullet lists. Keep a single rung under ~250 words.`;

/* ----------------------------- context builders ----------------------------- */

function platformLine(index: ProjectIndex): string {
  const c = index.project.controller;
  return `${index.isLogix ? "ControlLogix/CompactLogix (Studio 5000)" : index.project.platform === "slc" ? "SLC 500 (RSLogix 500)" : "PLC-5 (RSLogix 5)"}${c.processorType ? `, processor ${c.processorType}` : ""}, project ${index.project.name}`;
}

function tagLines(index: ProjectIndex, where: Scope, rungs: Rung[], limit = 400): string[] {
  const seen = new Map<string, string>();
  for (const rung of rungs) {
    for (const ins of instructionsOf(rung.ladder)) {
      for (const op of ins.operands) {
        if (!isTagOperand(op, index.isLogix ? "logix" : "classic") || seen.has(op)) continue;
        const r = index.resolve(op, where);
        const parts = [`- ${op}`];
        if (r.dataType) parts.push(`[${r.dataType}]`);
        if (r.description) parts.push(`"${r.description.replace(/\s*\n\s*/g, " ")}"`);
        if (r.hasValue && typeof r.value !== "object") parts.push(`= ${formatValue(r.value)}`);
        if (r.instancePath) parts.push(`(instance tag ${r.instancePath})`);
        if (r.forced) parts.push(`FORCED ${r.forced.toUpperCase()}`);
        seen.set(op, parts.join(" "));
        if (seen.size >= limit) break;
      }
    }
  }
  return [...seen.values()];
}

function blockerLines(blockers: Blocker[], index: ProjectIndex, where: Scope, indent = "  "): string[] {
  return blockers.flatMap((b) =>
    b.kind === "instr"
      ? [`${indent}- ${describeBlocker(b.node, b.state, index, where).text}`]
      : [
          `${indent}- one of these branches must be true:`,
          ...b.branches.flatMap((br, i) => [`${indent}  - branch ${i + 1}:`, ...blockerLines(br, index, where, `${indent}    `)]),
        ],
  );
}

export function rungContext(index: ProjectIndex, where: Scope & { routine: string }, rung: Rung, ev: RungEvaluation | null): string {
  const lines: string[] = [];
  lines.push(`Platform: ${platformLine(index)}`);
  lines.push(
    `Location: ${where.kind === "aoi" ? `Add-On Instruction ${where.owner}` : `program ${where.owner}`}, routine ${where.routine}, rung ${rung.index}`,
  );
  if (where.instance) lines.push(`Viewed through AOI instance ${where.instance.tag} (called from ${where.instance.caller.owner}).`);
  if (rung.title) lines.push(`Rung title: ${rung.title}`);
  if (rung.comment) lines.push(`Rung comment:\n${rung.comment}`);
  lines.push(`Rung logic: ${rung.text}`);
  lines.push("Tags and addresses on this rung (description, saved value):", ...tagLines(index, where, [rung]));
  if (ev) {
    lines.push(`Saved-value evaluation: the rung's conditions are ${ev.out === true ? "TRUE" : ev.out === false ? "FALSE" : "UNKNOWN"}.`);
    for (const o of ev.outputs) {
      const st = ev.states.get(o)?.in;
      lines.push(`- ${o.mnemonic}(${o.operands.join(",")}): ${st === true ? "energized" : st === false ? "not energized" : "unknown"}`);
      if (st === false) lines.push(...blockerLines(ev.blockers(o), index, where, "    "));
    }
  }
  const s = summarizeRung(rung, index, where);
  lines.push(`Rule-based summary: ${s.conditions ? `When ${s.conditions} → ` : ""}${s.actions}`);
  lines.push("\nExplain what this rung does, its current state from the saved values, and what to check if its output isn't doing what's expected.");
  return lines.join("\n");
}

const MAX_CHARS = 60000;

export function routineContext(index: ProjectIndex, where: Scope & { routine: string }, routine: Routine): string {
  const lines: string[] = [`Platform: ${platformLine(index)}`];
  lines.push(`${where.kind === "aoi" ? `Add-On Instruction ${where.owner}` : `Program ${where.owner}`}, routine ${routine.name} (${routine.rungs.length} rungs)`);
  const owner = where.kind === "aoi" ? index.aoi(where.owner) : index.program(where.owner);
  if (routine.description ?? owner?.description) lines.push(`Description: ${routine.description ?? owner?.description}`);
  if (routine.type === "st") lines.push("Structured Text:", ...(routine.stLines ?? []));
  let size = lines.join("\n").length;
  let truncated = false;
  for (const rung of routine.rungs) {
    const block = `Rung ${rung.index}:${rung.comment ? ` // ${rung.comment.replace(/\s*\n\s*/g, " ").slice(0, 400)}` : ""}\n  ${rung.text}`;
    if (size + block.length > MAX_CHARS) {
      truncated = true;
      break;
    }
    lines.push(block);
    size += block.length;
  }
  const tags = tagLines(index, where, routine.rungs, 250);
  lines.push("Tags used (description, saved value):", ...tags);
  if (truncated) lines.push("(Routine truncated to fit — later rungs omitted.)");
  lines.push(
    "\nGive an overview of what this routine does for the machine: its sections in order, the key outputs it controls and the interlocks/permissives, and anything that looks unusual. Then list the most useful things to check when troubleshooting it.",
  );
  return lines.join("\n");
}

export function aoiContext(index: ProjectIndex, aoi: AoiDefinition): string {
  const lines = [`Platform: ${platformLine(index)}`, `Add-On Instruction ${aoi.name}${aoi.revision ? ` rev ${aoi.revision}` : ""}`];
  if (aoi.description) lines.push(`Description: ${aoi.description}`);
  if (aoi.helpText) lines.push(`Vendor help text: ${aoi.helpText.slice(0, 3000)}`);
  lines.push("Parameters:", ...aoi.parameters.map((p) => `- ${p.name} [${p.usage ?? "?"} ${p.dataType}]${p.required ? " required" : ""}: ${p.description?.replace(/\s*\n\s*/g, " ") ?? ""}`));
  lines.push("Local tags:", ...aoi.localTags.map((p) => `- ${p.name} [${p.dataType}]: ${p.description?.replace(/\s*\n\s*/g, " ") ?? ""}`));
  let size = lines.join("\n").length;
  for (const r of aoi.routines) {
    lines.push(`Routine ${r.name}:`);
    for (const rung of r.rungs) {
      const block = `Rung ${rung.index}:${rung.comment ? ` // ${rung.comment.replace(/\s*\n\s*/g, " ").slice(0, 300)}` : ""}\n  ${rung.text}`;
      if (size + block.length > MAX_CHARS) break;
      lines.push(block);
      size += block.length;
    }
    if (r.stLines) lines.push(...r.stLines.slice(0, 400));
  }
  if (aoi.encoded) lines.push("(Logic is source-protected; only the interface is known.)");
  lines.push("\nExplain what this Add-On Instruction does, how its inputs and outputs are meant to be used, and how a technician should read its status outputs when troubleshooting.");
  return lines.join("\n");
}

export function tagContext(index: ProjectIndex, ref: string, where: Scope): string {
  const info = index.resolve(ref, where);
  const lines = [`Platform: ${platformLine(index)}`, `Tag/address: ${info.key}${info.symbol && info.symbol !== info.key ? ` (symbol ${info.symbol})` : ""}`];
  if (info.description) lines.push(`Description: ${info.description}`);
  if (info.dataType) lines.push(`Type: ${info.dataType}`);
  if (info.aliasFor) lines.push(`Alias for: ${info.aliasFor}`);
  if (info.hasValue) lines.push(`Saved value: ${typeof info.value === "object" ? JSON.stringify(info.value).slice(0, 2000) : formatValue(info.value)}`);
  const hits = index.hitsRelated(info.key, info.base);
  const writes = hits.filter((h) => h.access === "write").slice(0, 25);
  const reads = hits.filter((h) => h.access === "read");
  lines.push(`Read in ${reads.length} places.`);
  lines.push("Rungs that write it:");
  for (const h of writes) {
    const rung = index.routine(h)?.rungs.find((r) => r.index === h.rung);
    if (!rung) continue;
    lines.push(`- ${h.owner} / ${h.routine} rung ${h.rung}${rung.comment ? ` // ${rung.comment.replace(/\s*\n\s*/g, " ").slice(0, 200)}` : ""}\n  ${rung.text}`);
  }
  lines.push("\nExplain what this signal is for, what turns it on and off, and how to troubleshoot it if it's stuck ON or OFF.");
  return lines.join("\n");
}

