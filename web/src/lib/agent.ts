/**
 * "Ask AI about this machine": an OpenAI tool-calling loop. The model asks
 * for lookups (search signals, trace why something is ON/OFF, read a rung,
 * alarms, health) and we answer them locally from the parsed project, so only
 * what it looks up is sent — never the whole program.
 */

import type { RoutineRef } from "@core/model/types";
import { formatValue, type ProjectIndex } from "@core/query/index";
import { plc5SnapshotTime, runHealthChecks } from "@core/logic/health";
import { findAlarms } from "@core/logic/overview";
import { ioPointOf, traceSignal } from "@core/logic/trace";
import type { Blocker } from "@core/logic/evaluate";
import { rungContext, type AiSettings } from "./ai";
import { describeBlocker } from "./explain";
import { evaluate } from "./power";
import { verdictFor } from "./troubleshoot";
import type { Attachment } from "./machines";
import { addressVariants, imageToDataUrl, renderPdfPage, searchPages } from "./pdf";
import { hmiAlarms, hmiLinksCached } from "@core/logic/hmi";

/* --------------------------------- messages --------------------------------- */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentStep {
  label: string;
}

/* ----------------------------------- tools ----------------------------------- */

const PANEL_TOOL = {
  type: "function",
  function: {
    name: "search_panel",
    description:
      "Search the operator panel (HMI) of this machine: screen names, button / indicator captions, PLC addresses on the screens, and the alarm message texts with their number and the rung that raises them. Use it when the user quotes what the screen says, names a button, or asks where something is on the HMI.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Words or an address, e.g. 'partial load', 'N23:1/5', 'hoist down'" } },
      required: ["text"],
    },
  },
} as const;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_signals",
      description:
        "Find tags/addresses (inputs, outputs, bits, timers…) whose name, symbol or description matches words. Try several phrasings and abbreviations (e.g. 'brake', 'brk'). Returns the best matches with saved value and whether it's a physical input/output.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Words to look for, e.g. 'seamer brake'" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trace_signal",
      description:
        "Explain why a signal is ON/OFF in the saved values: every rung that writes it, whether each has power, and the conditions blocking it (each with a ref you can trace next).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Tag or address exactly as returned by search_signals, e.g. 'O:002/11' or 'Motor.Run'" },
          program: { type: "string", description: "Program the tag is used in (from search results), for program-scoped tags" },
        },
        required: ["ref"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rung",
      description: "Read one rung: its logic text, comment, tags with descriptions and saved values, and which outputs have power.",
      parameters: {
        type: "object",
        properties: {
          program: { type: "string" },
          routine: { type: "string", description: "Routine name (PLC-5: same as the program file name)" },
          rung: { type: "integer" },
        },
        required: ["program", "rung"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_rungs",
      description: "Search rung comments and rung logic text for words; returns matching rung locations with their comment.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_alarms",
      description: "Alarm / fault bits set by the logic, with their saved state.",
      parameters: { type: "object", properties: { active_only: { type: "boolean" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "health_findings",
      description: "Program-wide health checks: forces, processor fault bits, duplicate outputs, latches never unlatched, timers running, etc.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_drawings",
      description: "List the electrical drawings / photos attached to this machine, with page counts and whether their text is searchable.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_drawings",
      description:
        "Search the text of the attached electrical drawings for an address, wire number, device tag or words (e.g. 'I:004/11', 'CR181', 'brake'). Returns drawing pages with a text snippet. Scanned drawings have no text — use view_drawing_page on likely pages instead.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "view_drawing_page",
      description: "Look at one page of an attached drawing as an image (to read wiring, terminal numbers, device tags). Use the drawing id from list_drawings/search_drawings.",
      parameters: {
        type: "object",
        properties: { drawing: { type: "string", description: "Drawing id (or file name)" }, page: { type: "integer" } },
        required: ["drawing", "page"],
      },
    },
  },
  PANEL_TOOL,
] as const;

/** Things the tools can use besides the parsed program. */
export interface AgentContext {
  attachments: Attachment[];
}

interface SignalEntry {
  ref: string;
  program: string;
  label: string;
  haystack: string;
}

const signalCache = new WeakMap<ProjectIndex, SignalEntry[]>();

/** Every tag/address the logic uses (plus documented PLC-5 addresses), with descriptions to search. */
function signals(index: ProjectIndex): SignalEntry[] {
  const hit = signalCache.get(index);
  if (hit) return hit;
  const out: SignalEntry[] = [];
  const seen = new Set<string>();
  for (const e of index.project.crossReference) {
    const h = e.hits.find((x) => x.kind === "program") ?? e.hits[0];
    if (!h || h.kind !== "program") continue;
    const info = index.resolve(h.address, { kind: "program", owner: h.owner });
    const label = e.key.replace(/^(Program|AOI):[^.]+\./, "");
    seen.add(e.key);
    out.push({
      ref: h.address,
      program: h.owner,
      label,
      haystack: `${label} ${info.symbol ?? ""} ${info.description ?? ""} ${info.aliasFor ?? ""}`.toLowerCase(),
    });
  }
  for (const s of index.project.symbols) {
    if (seen.has(s.address)) continue;
    out.push({
      ref: s.address,
      program: index.project.programs[0]?.name ?? "",
      label: s.address,
      haystack: `${s.address} ${s.symbol ?? ""} ${s.description ?? ""}`.toLowerCase(),
    });
  }
  signalCache.set(index, out);
  return out;
}

const STOP = new Set(
  "the a an is are was it its on off why wont won't doesnt doesn't not dont don't turn turning show me what whats what's problem and or of to in at for my this that with be stuck keeps keep stay stays staying how do does can cant can't".split(
    " ",
  ),
);

export function searchSignals(index: ProjectIndex, query: string, limit = 15) {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9:/._[\]-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  if (!words.length) return [];
  const scored: { s: SignalEntry; score: number }[] = [];
  for (const s of signals(index)) {
    let score = 0;
    for (const w of words) if (s.haystack.includes(w)) score += w.length > 3 ? 2 : 1;
    if (score) scored.push({ s, score });
  }
  scored.sort((a, b) => b.score - a.score || a.s.label.localeCompare(b.s.label, undefined, { numeric: true }));
  return scored.slice(0, limit).map(({ s }) => {
    const info = index.resolve(s.ref, { kind: "program", owner: s.program });
    const io = ioPointOf(index, info);
    const writes = index.hitsRelated(info.key, info.base).filter((h) => h.access === "write").length;
    return {
      ref: s.ref,
      program: s.program,
      name: s.label,
      ...(info.symbol && info.symbol !== s.label ? { symbol: info.symbol } : {}),
      description: info.description?.replace(/\s*\n\s*/g, " ") ?? "",
      value: info.hasValue && typeof info.value !== "object" ? formatValue(info.value) : "unknown",
      ...(io ? { io: `${io.kind} — ${io.location}` } : {}),
      written_by_logic: writes,
    };
  });
}

function blockerJson(blockers: Blocker[], index: ProjectIndex, where: { kind: "program" | "aoi"; owner: string }): unknown[] {
  return blockers.map((b) =>
    b.kind === "instr"
      ? { needs: describeBlocker(b.node, b.state, index, where).text, ref: describeBlocker(b.node, b.state, index, where).ref }
      : { one_of_these_branches: b.branches.map((br) => blockerJson(br, index, where)) },
  );
}

function ownerOf(index: ProjectIndex, ref: string, program?: string): string {
  if (program && index.program(program)) return program;
  const s = signals(index).find((x) => x.ref === ref || x.label === ref);
  return s?.program ?? index.project.programs[0]?.name ?? "";
}

function routineFor(index: ProjectIndex, program: string, routine?: string): RoutineRef | undefined {
  const p = index.program(program) ?? index.project.programs.find((x) => x.name.toLowerCase() === program.toLowerCase());
  if (!p) return undefined;
  const r =
    p.routines.find((x) => x.name === routine) ??
    p.routines.find((x) => x.name.toLowerCase() === routine?.toLowerCase()) ??
    p.routines.find((x) => x.name === p.mainRoutine) ??
    p.routines[0];
  return r ? { kind: "program", owner: p.name, routine: r.name } : undefined;
}

const clip = (s: string, n = 7000) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

export async function runTool(
  index: ProjectIndex,
  name: string,
  args: Record<string, unknown>,
  ctx: AgentContext = { attachments: [] },
): Promise<{ result: string; label: string; image?: string }> {
  try {
    switch (name) {
      case "search_signals": {
        const q = String(args.query ?? "");
        const r = searchSignals(index, q);
        return { label: `Searched signals for “${q}” — ${r.length} match${r.length === 1 ? "" : "es"}`, result: JSON.stringify(r) };
      }
      case "trace_signal": {
        const ref = String(args.ref ?? "");
        const owner = ownerOf(index, ref, args.program ? String(args.program) : undefined);
        const where = { kind: "program" as const, owner };
        const t = traceSignal(index, ref, where);
        const v = verdictFor(index, t);
        const direct = t.writers.filter((w) => w.direct);
        const out = {
          signal: t.info.key.replace(/^(Program|AOI):[^.]+\./, ""),
          program: owner,
          description: t.info.description?.replace(/\s*\n\s*/g, " "),
          saved_value: t.info.hasValue && typeof t.info.value !== "object" ? formatValue(t.info.value) : t.info.hasValue ? JSON.stringify(t.info.value).slice(0, 400) : "unknown",
          ...(t.io ? { physical: `${t.io.kind} — ${t.io.location}` } : {}),
          ...(t.info.forced ? { forced: t.info.forced } : {}),
          ...(t.info.aliasFor ? { alias_for: t.info.aliasFor } : {}),
          verdict: v.text,
          writers: direct.slice(0, 12).map((w) => ({
            what: w.effect,
            instruction: `${w.instruction.mnemonic}(${w.instruction.operands.join(",")})`,
            location: { program: w.where.owner, routine: w.where.routine, rung: w.hit.rung },
            has_power: w.energized,
            ...(w.energized !== true && w.blockers.length ? { blocked_by: blockerJson(w.blockers, index, { kind: w.where.kind, owner: w.where.owner }) } : {}),
          })),
          ...(direct.length > 12 ? { more_writers: direct.length - 12 } : {}),
          ...(t.writers.length > direct.length ? { also_written_as_part_of_structure: t.writers.length - direct.length } : {}),
        };
        return { label: `Traced ${out.signal} (${out.saved_value})`, result: clip(JSON.stringify(out)) };
      }
      case "get_rung": {
        const where = routineFor(index, String(args.program ?? ""), args.routine ? String(args.routine) : undefined);
        const n = Number(args.rung);
        const rung = where ? index.routine(where)?.rungs.find((r) => r.index === n) : undefined;
        if (!where || !rung) return { label: `Couldn't find rung ${n} in ${String(args.program)}`, result: "Not found. Check the program/routine name." };
        const ev = rung.ladder ? evaluate(rung.ladder, index, where) : null;
        const text = rungContext(index, where, rung, ev).replace(/\n\nExplain what this rung does[\s\S]*$/, "");
        return { label: `Read ${where.owner}${index.isLogix ? ` › ${where.routine}` : ""} rung ${n}`, result: clip(text) };
      }
      case "find_rungs": {
        const words = String(args.text ?? "")
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 1 && !STOP.has(w));
        const out: unknown[] = [];
        for (const p of index.project.programs) {
          for (const r of p.routines) {
            for (const rung of r.rungs) {
              const hay = `${rung.comment ?? ""} ${rung.title ?? ""} ${rung.text}`.toLowerCase();
              if (words.length && words.every((w) => hay.includes(w))) {
                out.push({ program: p.name, routine: r.name, rung: rung.index, comment: rung.comment?.replace(/\s*\n\s*/g, " ").slice(0, 160), logic: rung.text.slice(0, 160) });
              }
              if (out.length >= 20) break;
            }
          }
        }
        return { label: `Searched rungs for “${String(args.text)}” — ${out.length} found`, result: JSON.stringify(out) };
      }
      case "search_panel": {
        const text = String(args.text ?? "");
        const r = searchPanel(index, text);
        return {
          label: `Searched the panel for “${text}” — ${r.objects.length + r.messages.length} found`,
          result: clip(JSON.stringify(r)),
        };
      }
      case "list_alarms": {
        const activeOnly = args.active_only !== false;
        const list = findAlarms(index).filter((a) => !activeOnly || a.active === true).slice(0, 40);
        return {
          label: `Listed ${activeOnly ? "active " : ""}alarms — ${list.length}`,
          result: JSON.stringify(
            list.map((a) => ({ ref: a.ref, program: a.where.owner, description: a.description, comment: a.comment, active: a.active, set_at: `${a.at.where.owner}/${a.at.where.routine}/${a.at.rung}` })),
          ),
        };
      }
      case "health_findings": {
        const f = runHealthChecks(index);
        return {
          label: `Checked program health — ${f.length} findings`,
          result: clip(JSON.stringify(f.map((x) => ({ severity: x.severity, title: x.title, count: x.total, examples: x.items.slice(0, 5).map((i) => `${i.label}${i.detail ? ` — ${i.detail}` : ""}`) })))),
        };
      }
      case "list_drawings": {
        const list = ctx.attachments.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.mime === "application/pdf" ? "pdf" : "image",
          pages: a.pageCount ?? 1,
          text_searchable: (a.pagesText ?? []).some((t) => t.length > 20),
        }));
        return { label: `Listed drawings — ${list.length}`, result: list.length ? JSON.stringify(list) : "No drawings are attached to this machine." };
      }
      case "search_drawings": {
        const text = String(args.text ?? "");
        const hits = searchPages(ctx.attachments, [...addressVariants(text), text], 25);
        return {
          label: `Searched drawings for “${text}” — ${hits.length} page${hits.length === 1 ? "" : "s"}`,
          result: JSON.stringify(hits.map((h) => ({ drawing: h.attachmentId, name: h.name, page: h.page, text: h.snippet }))),
        };
      }
      case "view_drawing_page": {
        const key = String(args.drawing ?? "");
        const a = ctx.attachments.find((x) => x.id === key) ?? ctx.attachments.find((x) => x.name.toLowerCase() === key.toLowerCase());
        if (!a) return { label: `Drawing ${key} not found`, result: "No drawing with that id. Use list_drawings." };
        const page = Math.max(1, Number(args.page) || 1);
        const image = a.mime === "application/pdf" ? await renderPdfPage(a.id, a.blob, page, 1600, "image/jpeg") : await imageToDataUrl(a.blob, 1600);
        return { label: `Looked at ${a.name}${a.mime === "application/pdf" ? ` page ${page}` : ""}`, result: `The image of ${a.name} page ${page} is attached in the next message.`, image };
      }
      default:
        return { label: `Unknown tool ${name}`, result: "Unknown tool." };
    }
  } catch (err) {
    return { label: `${name} failed`, result: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Panel objects and alarm messages matching every word (or an address). */
function searchPanel(index: ProjectIndex, text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (hay: string) => words.length > 0 && words.every((w) => hay.includes(w));
  const links = hmiLinksCached(index);
  const hasLogic = index.project.programs.length > 0;
  // Same button / indicator repeated on many screens → one entry listing the screens.
  const found = new Map<string, { entry: Record<string, unknown>; screens: string[] }>();
  for (const hmi of index.project.hmi ?? []) {
    for (const screen of hmi.screens) {
      for (const o of screen.objects) {
        if (o.kind === "shape" || o.kind === "group") continue;
        const addrs = [...new Set(o.connections.flatMap((c) => c.refs.map((r) => r.address)))];
        const hay = `${o.captions.join(" ")} ${o.name} ${screen.name} ${addrs.join(" ")}`.toLowerCase();
        if (!hits(hay) && !hits(screen.name.toLowerCase())) continue;
        const key = `${o.type}|${o.captions.join("|")}|${addrs.join(",")}`;
        const seen = found.get(key);
        if (seen) {
          seen.screens.push(screen.name);
          continue;
        }
        if (found.size >= 25) continue;
        const captions = o.captions.map((c) => c.replace(/\s+/g, " "));
        // Indicators can have dozens of state texts: keep the ones that match.
        const shownCaptions = captions.length > 4 ? captions.filter((c, n) => n === 0 || hits(c.toLowerCase())).slice(0, 6) : captions;
        const entry: Record<string, unknown> = {
          object: o.name,
          type: o.type,
          captions: shownCaptions,
          ...(captions.length > shownCaptions.length ? { states_total: captions.length } : {}),
          ...(o.goto ? { opens_screen: o.goto } : {}),
          connections: o.connections
            .filter((c) => c.access !== "animation")
            .flatMap((c) =>
              c.refs.map((r) => {
                const local = hasLogic && !!r.shortcut && links.local.has(r.shortcut.toLowerCase());
                const info = local ? index.resolve(r.address, { kind: "program", owner: "" }) : undefined;
                return {
                  access: c.access === "write" ? "panel writes it" : c.access === "readwrite" ? "entered on the panel" : "shown on the panel",
                  address: r.address,
                  ...(info?.description ? { description: info.description } : {}),
                  ...(info?.hasValue ? { saved_value: formatValue(info.value, 20) } : {}),
                };
              }),
            ),
        };
        found.set(key, { entry, screens: [screen.name] });
      }
    }
  }
  const objects = [...found.values()].map(({ entry, screens }) => ({ screens: screens.slice(0, 8), ...(screens.length > 8 ? { on_screens: screens.length } : {}), ...entry }));
  const messages = hmiAlarms(index, links)
    .filter((m) => hits(m.text.toLowerCase()) || words.join(" ") === String(m.value))
    .slice(0, 15)
    .map((m) => ({
      number: m.value,
      text: m.text,
      trigger: m.trigger?.refs[0]?.address,
      raised_by: m.raisers.map((r) => `${r.where.owner}/${r.where.routine}/${r.rung} (${r.detail})`),
    }));
  return { objects, messages };
}

/* ------------------------------- system prompt ------------------------------- */

export function agentSystemPrompt(index: ProjectIndex, attachments: Attachment[] = []): string {
  const p = index.project;
  const snapshot = plc5SnapshotTime(index);
  const programs = p.programs
    .map((x) => `- ${x.number !== undefined ? `${x.number} - ` : ""}${x.name}${x.description ? `: ${x.description.split("\n")[0]}` : ""}${index.isLogix ? ` (routines: ${x.routines.map((r) => r.name).join(", ")})` : ""}`)
    .join("\n");
  return `You are a senior Allen-Bradley controls engineer helping a plant maintenance technician troubleshoot a machine from its PLC program export. You can't see the program directly — use the tools to look things up.

Machine: ${p.name} — ${index.isLogix ? "ControlLogix/CompactLogix (Studio 5000)" : index.project.platform === "slc" ? "SLC 500 (RSLogix 500)" : "PLC-5 (RSLogix 5)"}${p.controller.processorType ? `, ${p.controller.processorType}` : ""}.
${snapshot ? `Saved values are a snapshot from ${snapshot} (processor clock), not live.` : "Saved values are a snapshot from when the file was saved, not live."}
Programs:
${programs.slice(0, 6000)}
${p.hmi?.length ? `Operator panel: ${p.hmi.map((h) => `${h.application} (${h.screens.length} screens, ${h.messages.length} alarm messages${h.triggers[0]?.refs[0] ? `; the PLC puts the message number in ${h.triggers[0].refs[0].address}` : ""})`).join("; ")}. Use search_panel for anything the user reads off the screen or presses on it.` : "No operator panel file is attached."}
${attachments.length ? `Attached drawings: ${attachments.map((a) => `${a.name}${a.pageCount ? ` (${a.pageCount} pages)` : ""}`).join(", ")}` : "No electrical drawings are attached yet."}

How to work:
1. Find the signal(s) the user means with search_signals. Descriptions are often abbreviated or in capitals — try a few phrasings (e.g. "seamer brake", "brake", "brk"). Prefer physical outputs/inputs and bits that logic writes.
2. trace_signal the most likely one. Follow blocked_by refs with trace_signal (usually 1–3 levels) until you reach a root cause: a field input, an HMI/config bit, a timer, a fault/latch.
3. Use get_rung to read a rung when the trace isn't enough. Use list_alarms / health_findings when the symptom sounds like a fault.
4. If the saved value contradicts the user (they say it's ON but it was saved OFF), say so — the snapshot may predate the problem — and explain what turns it ON and what turns it OFF.

Drawings and photos:
- If the user attaches a photo (HMI alarm screen, wire label, terminal strip, device nameplate, panel), read every bit of text in it and use search_panel / search_signals / find_rungs / search_drawings to find what it refers to (an alarm text on the screen is usually in search_panel with the rung that raises it).
- Use list_drawings / search_drawings / view_drawing_page to find where a device or I/O point is wired: terminal numbers, wire numbers, fuses, relays in the circuit. Cite drawing pages as "Drawing <name> p.<n>".

Answer format:
- Start with a one-paragraph plain answer: what the signal is and why it's in that state.
- Then "Why" as a short chain of conditions, and "What to check on the machine" as bullets (sensors, push buttons, guards, drives, wiring, HMI settings).
- Cite every rung and signal as a Markdown link so the user can click it: rungs as [MAIN rung 7](rung:MAIN/MAIN/7) using rung:<program>/<routine>/<rung number>, and signals as [O:002/11](tag:O:002/11@MAIN) using tag:<ref>@<program>.
- Be concise. Don't invent tags or logic you haven't looked up.`;
}

/* ------------------------------------ loop ----------------------------------- */

async function complete(settings: AiSettings, messages: AgentMessage[], withTools: boolean, signal?: AbortSignal) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.model,
      messages,
      ...(withTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
    }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      // keep status
    }
    throw new Error(res.status === 401 ? `OpenAI rejected the API key (${detail}). Check it in Settings.` : `OpenAI error: ${detail}`);
  }
  const body = (await res.json()) as { choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[] };
  return body.choices[0]?.message ?? { content: null };
}

const MAX_ROUNDS = 10;

/**
 * Run one user turn: let the model call tools until it answers.
 * `history` already ends with the user's message; returns the new messages to append.
 */
export async function runAgent(
  settings: AiSettings,
  index: ProjectIndex,
  history: AgentMessage[],
  onStep: (step: AgentStep) => void,
  signal?: AbortSignal,
  ctx: AgentContext = { attachments: [] },
): Promise<AgentMessage[]> {
  const added: AgentMessage[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const msg = await complete(settings, [...history, ...added], true, signal);
    if (!msg.tool_calls?.length) {
      added.push({ role: "assistant", content: msg.content?.trim() || "(no answer)" });
      return added;
    }
    added.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    const images: ContentPart[] = [];
    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // leave empty
      }
      const { result, label, image } = await runTool(index, call.function.name, args, ctx);
      onStep({ label });
      added.push({ role: "tool", tool_call_id: call.id, content: result });
      if (image) images.push({ type: "image_url", image_url: { url: image, detail: "high" } });
    }
    // Tool results can only be text, so page images go in a follow-up message.
    if (images.length) added.push({ role: "user", content: [{ type: "text", text: "Drawing page image(s) you asked to view:" }, ...images] });
  }
  // Out of rounds: ask for the best answer with what it has.
  const final = await complete(settings, [...history, ...added, { role: "user", content: "Answer now with what you've found." }], false, signal);
  added.push({ role: "assistant", content: final.content?.trim() || "(no answer)" });
  return added;
}

