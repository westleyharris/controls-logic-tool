/**
 * Start-up checklist and alarm handbook: walk back from an output (or an
 * alarm bit) through the rungs that drive it and list the field devices,
 * faults, timers and setpoints that have to be right.
 */

import type { LadderInstruction } from "../ladder/ast.js";
import type { ProjectIndex, RefInfo, Scope } from "../query/index.js";
import type { Blocker, Tri } from "./evaluate.js";
import { ALARM_WORDS, ESTOP, type AlarmEntry } from "./overview.js";
import { evaluateInScope, ioPointOf, traceSignal, type IoPoint, type TraceWriter } from "./trace.js";

export type CheckCategory = "field-input" | "field-output" | "fault" | "timer" | "setpoint" | "external" | "internal" | "aoi";

export const CATEGORY_TITLE: Record<CheckCategory, string> = {
  "field-input": "Field devices (inputs)",
  "field-output": "Outputs that must be on / off",
  fault: "Faults and stops that must be clear",
  timer: "Timers that must finish",
  setpoint: "Setpoints and values",
  external: "Set from outside the logic (HMI, comms)",
  internal: "Other conditions",
  aoi: "Add-On Instructions",
};

export const CATEGORY_ORDER: CheckCategory[] = ["field-input", "fault", "external", "setpoint", "timer", "field-output", "aoi", "internal"];

export interface CheckItem {
  /** Stable key (for saved tick marks). */
  id: string;
  /** Operand to trace further ("Why?"), when there is one. */
  ref?: string;
  where: Scope;
  label: string;
  description?: string;
  /** What it must be: "ON", "OFF", "N7:5 ≥ 100", … */
  need: string;
  /** Was it right in the saved values? */
  ok: Tri;
  category: CheckCategory;
  io?: IoPoint;
  /** The signal it was found under. */
  via?: string;
  note?: string;
  /** Items sharing a group: any one of them is enough. */
  group?: string;
  at: { where: { kind: "program" | "aoi"; owner: string; routine: string }; rung: number };
}

export interface Checklist {
  target: RefInfo;
  items: CheckItem[];
  /** One-of groups: id → title. */
  groups: Record<string, string>;
  truncated: boolean;
  writers: number;
}

const COMPARE: Record<string, string> = { EQU: "=", NEQ: "≠", LES: "<", LEQ: "≤", GRT: ">", GEQ: "≥" };

const oneLine = (s?: string) => s?.replace(/\s*\n\s*/g, " ").trim() || undefined;

function valueText(index: ProjectIndex, ref: string | undefined, where: Scope): string {
  if (!ref) return "?";
  if (/^[-+]?\d/.test(ref.trim())) return ref.trim();
  const r = index.resolve(ref, where);
  if (r.value === undefined || typeof r.value === "object") return "?";
  if (typeof r.value === "boolean") return r.value ? "ON" : "OFF";
  return String(Number.isInteger(r.value as number) ? r.value : Number((r.value as number).toPrecision(6)));
}

/** Timer preset in seconds from the TON/TOF/RTO that drives `timer`. */
function timerPreset(index: ProjectIndex, writers: TraceWriter[]): string | undefined {
  const w = writers.find((x) => x.effect === "timer");
  if (!w) return undefined;
  const ops = w.instruction.operands;
  if (index.isLogix) {
    const pre = Number(ops[1]);
    return Number.isFinite(pre) ? `${pre / 1000} s` : undefined;
  }
  // PLC-5 / SLC: TON T4:1 <base> <pre> <acc>
  const base = Number(ops[1]);
  const pre = Number(ops[2]);
  return Number.isFinite(base) && Number.isFinite(pre) ? `${Number((base * pre).toPrecision(6))} s` : undefined;
}

export interface WalkOptions {
  maxDepth?: number;
  maxItems?: number;
  /** Which writers to follow for the starting signal. */
  start?: "on" | "off";
}

/** Walk the permissives of `ref`: everything that must be right for it to turn ON (or OFF with start = "off"). */
export function buildChecklist(index: ProjectIndex, ref: string, where: Scope, opts: WalkOptions = {}): Checklist {
  const maxDepth = opts.maxDepth ?? 5;
  const maxItems = opts.maxItems ?? 250;
  const target = index.resolve(ref, where);
  const items: CheckItem[] = [];
  const groups: Record<string, string> = {};
  const seenItems = new Set<string>();
  const expanded = new Set<string>([target.key]);
  let truncated = false;
  let groupSeq = 0;
  let writersCount = 0;

  const queue: { ref: string; where: Scope; depth: number; via?: string; effects: TraceWriter["effect"][] }[] = [
    { ref, where, depth: 0, effects: opts.start === "off" ? ["reset"] : ["drive", "set", "timer"] },
  ];

  const push = (item: Omit<CheckItem, "id">) => {
    const id = `${item.category}|${item.ref ?? item.label}|${item.need}|${item.group ?? ""}`;
    if (seenItems.has(id)) return;
    if (items.length >= maxItems) {
      truncated = true;
      return;
    }
    seenItems.add(id);
    items.push({ id, ...item });
  };

  const leaf = (
    ins: LadderInstruction,
    state: Tri,
    scope: Scope,
    at: CheckItem["at"],
    depth: number,
    via: string | undefined,
    group: string | undefined,
  ) => {
    const m = ins.mnemonic.toUpperCase();
    const [a, b, c] = ins.operands;
    const base = { where: scope, ok: state, at, ...(via ? { via } : {}), ...(group ? { group } : {}) };
    if (m === "XIC" || m === "XIO") {
      if (!a) return;
      const info = index.resolve(a, scope);
      if (info.key === target.key) return; // seal-in contact on itself
      const description = oneLine(info.description);
      const io = ioPointOf(index, info);
      const need = m === "XIC" ? "ON" : "OFF";
      const common = { ...base, ref: a, label: a, need, ...(description ? { description } : {}) };
      if (io) {
        push({ ...common, category: io.kind === "input" ? "field-input" : "field-output", io });
        return;
      }
      const isTimerBit = /[./](DN|TT|EN)$/i.test(info.key);
      const writes = index.hitsRelated(info.key, info.base).filter((h) => h.access === "write");
      if (!writes.length && !isTimerBit) {
        push({ ...common, category: "external", note: "Nothing in the logic writes it" });
        return;
      }
      const text = `${info.key} ${info.symbol ?? ""} ${info.description ?? ""}`;
      if (m === "XIO" && (ALARM_WORDS.test(text) || ESTOP.test(text))) {
        push({ ...common, category: "fault" });
        return;
      }
      const canExpand = !group && depth < maxDepth && !expanded.has(info.key);
      if (isTimerBit && m === "XIC") {
        const t = traceSignal(index, a, scope);
        const pre = timerPreset(index, t.writers);
        push({ ...common, category: "timer", need: /DN$/i.test(info.key) ? "done" : "timing", ...(pre ? { note: `Preset ${pre}` } : {}) });
        if (canExpand) {
          expanded.add(info.key);
          queue.push({ ref: a, where: scope, depth: depth + 1, via: description ?? a, effects: ["timer"] });
        }
        return;
      }
      if (m === "XIO" || !canExpand) {
        if (m === "XIO" || !expanded.has(info.key)) push({ ...common, category: "internal" });
        return;
      }
      // An internal bit that must be ON: list what turns it on instead.
      expanded.add(info.key);
      queue.push({ ref: a, where: scope, depth: depth + 1, via: description ?? a, effects: ["drive", "set", "timer"] });
      return;
    }
    if (COMPARE[m]) {
      push({
        ...base,
        ...(a && !/^[-+]?\d/.test(a) ? { ref: a } : {}),
        label: `${a} ${COMPARE[m]} ${b}`,
        need: `${a} ${COMPARE[m]} ${b}`,
        note: `Saved: ${valueText(index, a, scope)} ${COMPARE[m]} ${valueText(index, b, scope)}`,
        category: "setpoint",
        ...(a && oneLine(index.resolve(a, scope).description) ? { description: oneLine(index.resolve(a, scope).description)! } : {}),
      });
      return;
    }
    if (m === "LIM") {
      push({
        ...base,
        ...(b && !/^[-+]?\d/.test(b) ? { ref: b } : {}),
        label: `${b} between ${a} and ${c}`,
        need: `${valueText(index, a, scope)} … ${valueText(index, c, scope)}`,
        note: `Saved: ${valueText(index, b, scope)}`,
        category: "setpoint",
      });
      return;
    }
    if (m === "MEQ" || m === "CMP") {
      push({ ...base, label: `${m} ${ins.operands.join(" ")}`, need: "true", category: "setpoint" });
      return;
    }
    if (m === "ONS" || m === "OSR" || m === "OSF" || m === "LBL") return;
    if (m === "AFI") {
      push({ ...base, label: "AFI", need: "removed", note: "This rung is disabled with AFI", category: "internal" });
      return;
    }
    const aoi = index.aoi(ins.mnemonic);
    if (aoi && a) {
      push({ ...base, ref: `${a}.EnableOut`, label: `${aoi.name} ${a}`, need: "EnableOut ON", category: "aoi", ...(aoi.description ? { description: oneLine(aoi.description)! } : {}) });
    }
  };

  const walk = (reqs: Blocker[], scope: Scope, at: CheckItem["at"], depth: number, via: string | undefined, group: string | undefined) => {
    for (const r of reqs) {
      if (r.kind === "instr") {
        leaf(r.node, r.state, scope, at, depth, via, group);
        continue;
      }
      // Parallel branches: any one is enough. Nested groups flatten into the outer one.
      const gid = group ?? `g${++groupSeq}`;
      if (!group) groups[gid] = `Any one of these${via ? ` (for ${via})` : ""}`;
      for (const branch of r.branches) walk(branch, scope, at, depth, via, gid);
    }
  };

  while (queue.length) {
    const next = queue.shift()!;
    const t = traceSignal(index, next.ref, next.where);
    const writers = t.writers.filter((w) => w.direct && next.effects.includes(w.effect));
    writersCount += writers.length;
    for (const w of writers) {
      const rung = index.routine(w.where)?.rungs.find((r) => r.index === w.hit.rung);
      if (!rung?.ladder) continue;
      const scope: Scope = { kind: w.where.kind, owner: w.where.owner };
      const ev = evaluateInScope(rung.ladder, index, scope);
      walk(ev.requirements(w.instruction), scope, { where: w.where, rung: w.hit.rung }, next.depth, next.via, undefined);
    }
  }

  const rank = (c: CheckCategory) => CATEGORY_ORDER.indexOf(c);
  items.sort((x, y) => rank(x.category) - rank(y.category));
  return { target, items, groups, truncated, writers: writersCount };
}

/* ---------------------------------- handbook ---------------------------------- */

export interface HandbookEntry {
  alarm: AlarmEntry;
  /** Conditions that raise it (from the rung(s) that set it, one level deep). */
  causes: CheckItem[];
  causeGroups: Record<string, string>;
  /** Latched alarms: what unlatches / resets it. */
  resets: CheckItem[];
  latched: boolean;
  /** Delay before it trips, when a timer is part of the cause. */
  delay?: string;
}

export function alarmHandbook(index: ProjectIndex, alarms: AlarmEntry[]): HandbookEntry[] {
  return alarms.map((alarm) => {
    const cause = buildChecklist(index, alarm.ref, alarm.where, { maxDepth: 1, maxItems: 40 });
    const latched = alarm.how === "OTL";
    const reset = latched ? buildChecklist(index, alarm.ref, alarm.where, { maxDepth: 0, maxItems: 20, start: "off" }) : undefined;
    const delay = cause.items.find((i) => i.category === "timer")?.note?.replace(/^Preset /, "");
    return {
      alarm,
      causes: cause.items,
      causeGroups: cause.groups,
      resets: reset?.items ?? [],
      latched,
      ...(delay ? { delay } : {}),
    };
  });
}
