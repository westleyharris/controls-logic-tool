/**
 * Whole-machine views: scan structure (task → program → JSR call tree),
 * I/O map, and alarm list — all derived from the logic and saved values.
 */

import type { RoutineRef, SavedValue } from "../model/types.js";
import { walkInstructions } from "../ladder/parse.js";
import type { ProjectIndex, Scope } from "../query/index.js";
import { logixBase, parseClassicAddress } from "./refs.js";

/* ------------------------------ scan structure ------------------------------ */

export interface CallNode {
  ref: RoutineRef;
  label: string;
  rungs: number;
  type: string;
  children: CallNode[];
  /** Already expanded earlier in the tree — children omitted. */
  repeat?: boolean;
}

export interface ScanProgram {
  name: string;
  description?: string;
  disabled?: boolean;
  root?: CallNode;
}

export interface ScanTask {
  name: string;
  kind: string;
  description?: string;
  inhibited?: boolean;
  programs: ScanProgram[];
}

export interface ScanStructure {
  tasks: ScanTask[];
  /** Routines / program files no call path reaches. */
  unreachable: RoutineRef[];
}

function jsrTargets(index: ProjectIndex, from: RoutineRef): RoutineRef[] {
  const routine = index.routine(from);
  const out: RoutineRef[] = [];
  const seen = new Set<string>();
  for (const rung of routine?.rungs ?? []) {
    if (!rung.ladder) continue;
    walkInstructions(rung.ladder, (ins) => {
      if (ins.mnemonic.toUpperCase() !== "JSR") return;
      const t = index.jsrTarget(ins.operands, from);
      if (t && !seen.has(`${t.owner}|${t.routine}`)) {
        seen.add(`${t.owner}|${t.routine}`);
        out.push(t);
      }
    });
  }
  return out;
}

export function scanStructure(index: ProjectIndex): ScanStructure {
  const expanded = new Set<string>();
  const reached = new Set<string>();
  const label = (r: RoutineRef) => {
    if (index.isLogix) return r.routine;
    const p = index.program(r.owner);
    return `${p?.number ?? ""} - ${r.owner}`;
  };
  const build = (ref: RoutineRef, path: Set<string>): CallNode => {
    const id = `${ref.owner}|${ref.routine}`;
    reached.add(id);
    const routine = index.routine(ref);
    const node: CallNode = { ref, label: label(ref), rungs: routine?.rungs.length ?? 0, type: routine?.type ?? "ladder", children: [] };
    if (expanded.has(id) || path.has(id)) {
      node.repeat = true;
      return node;
    }
    expanded.add(id);
    const next = new Set(path).add(id);
    node.children = jsrTargets(index, ref).map((t) => build(t, next));
    return node;
  };

  const project = index.project;
  const tasks: ScanTask[] = [];
  if (index.isLogix) {
    for (const t of project.tasks) {
      const task: ScanTask = {
        name: t.name,
        kind: [t.type?.toLowerCase(), t.rate && t.type !== "CONTINUOUS" ? `${t.rate} ms` : ""].filter(Boolean).join(" · "),
        programs: [],
      };
      if (t.description) task.description = t.description;
      if (t.inhibited) task.inhibited = true;
      for (const name of t.programs) {
        const p = index.program(name);
        if (!p) continue;
        const sp: ScanProgram = { name: p.name };
        if (p.description) sp.description = p.description;
        if (p.disabled) sp.disabled = true;
        const main = p.mainRoutine ?? p.routines[0]?.name;
        if (main) sp.root = build({ kind: "program", owner: p.name, routine: main }, new Set());
        if (p.faultRoutine) build({ kind: "program", owner: p.name, routine: p.faultRoutine }, new Set());
        task.programs.push(sp);
      }
      tasks.push(task);
    }
  } else {
    const sval = (n: number) => index.resolve(`S:${n}`, { kind: "program", owner: "" }).value;
    const byNumber = (n: number) => project.programs.find((p) => p.number === n);
    const mainProg = byNumber(2) ?? project.programs[0];
    const entry = (title: string, kind: string, num: unknown) => {
      if (typeof num !== "number" || num <= 0) return;
      const p = byNumber(num);
      if (!p?.routines[0]) return;
      tasks.push({ name: title, kind, programs: [{ name: p.name, root: build({ kind: "program", owner: p.name, routine: p.routines[0].name }, new Set()) }] });
    };
    if (mainProg?.routines[0]) {
      tasks.push({
        name: "Main program",
        kind: "continuous",
        programs: [{ name: mainProg.name, root: build({ kind: "program", owner: mainProg.name, routine: mainProg.routines[0].name }, new Set()) }],
      });
    }
    entry("Fault routine (S:29)", "on major fault", sval(29));
    entry("Selectable timed interrupt (S:31)", "STI", sval(31));
    entry(project.platform === "slc" ? "Discrete input interrupt (S:46)" : "Processor input interrupt (S:46)", project.platform === "slc" ? "DII" : "PII", sval(46));
  }

  const unreachable: RoutineRef[] = [];
  for (const p of project.programs) {
    for (const r of p.routines) {
      if (!reached.has(`${p.name}|${r.name}`)) unreachable.push({ kind: "program", owner: p.name, routine: r.name });
    }
  }
  return { tasks, unreachable };
}

/* ---------------------------------- I/O map --------------------------------- */

export interface IoPoint {
  /** Address or tag as used. */
  ref: string;
  where: Scope & { routine: string };
  label: string;
  description?: string;
  value?: SavedValue;
  forced?: "on" | "off";
  kind: "input" | "output";
  usedInLogic: boolean;
}

export interface IoGroup {
  /** e.g. "Rack 0 · Group 4" or "I30 — Synchronized Inputs Of Node 30". */
  title: string;
  subtitle?: string;
  points: IoPoint[];
}

const anyScope = (index: ProjectIndex) => ({ kind: "program" as const, owner: index.project.programs[0]?.name ?? "", routine: "" });

export function ioMap(index: ProjectIndex): IoGroup[] {
  const project = index.project;
  const byKey = new Map(project.crossReference.map((e) => [e.key, e]));

  if (!index.isLogix) {
    const groups = new Map<string, { rack: number; group: number; points: IoPoint[] }>();
    const seen = new Set<string>();
    const add = (address: string) => {
      if (seen.has(address)) return;
      const a = parseClassicAddress(address);
      if (!a || (a.type !== "I" && a.type !== "O") || a.element === undefined || a.bit === undefined) return;
      seen.add(address);
      // SLC: group by slot; PLC-5: by rack and group (octal word).
      const rack = a.slot !== undefined ? -1 : Math.floor(a.element / 8);
      const group = a.slot !== undefined ? a.slot : a.element % 8;
      const key = `${rack}|${group}`;
      if (!groups.has(key)) groups.set(key, { rack, group, points: [] });
      const entry = byKey.get(address);
      const hit = entry?.hits[0];
      const where = hit ? { kind: hit.kind, owner: hit.owner, routine: hit.routine } : anyScope(index);
      const info = index.resolve(address, where);
      const p: IoPoint = {
        ref: address,
        where,
        label: address,
        kind: a.type === "I" ? "input" : "output",
        usedInLogic: !!entry,
      };
      if (info.description) p.description = info.description;
      if (info.hasValue) p.value = info.value!;
      if (info.forced) p.forced = info.forced;
      groups.get(key)!.points.push(p);
    };
    for (const e of project.crossReference) add(e.key);
    for (const s of project.symbols) add(s.address);
    return [...groups.values()]
      .sort((x, y) => x.rack - y.rack || x.group - y.group)
      .map((g) => {
        if (g.rack === -1) {
          const mod = project.modules.flatMap((m) => [m, ...m.children]).find((m) => m.slot === String(g.group));
          return {
            title: `Slot ${g.group}${mod?.catalogNumber ? ` · ${mod.catalogNumber}` : ""}`,
            ...(mod?.description ? { subtitle: mod.description } : {}),
            points: g.points.sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true })),
          };
        }
        return {
        title: `Rack ${g.rack.toString(8)} · Group ${g.group}`,
        subtitle: `I:${(g.rack * 8 + g.group).toString(8).padStart(3, "0")} / O:${(g.rack * 8 + g.group).toString(8).padStart(3, "0")}`,
        points: g.points.sort((x, y) => (x.kind === y.kind ? x.label.localeCompare(y.label, undefined, { numeric: true }) : x.kind === "input" ? -1 : 1)),
        };
      });
  }

  // Logix: alias tags grouped by what they point at (module tags or I/O image arrays).
  const groups = new Map<string, IoPoint[]>();
  for (const t of project.tags) {
    if (!t.aliasFor) continue;
    const key = t.scope ? `Program:${t.scope}.${t.name}` : t.name;
    const entry = byKey.get(key);
    const hits = entry ? index.hitsRelated(entry.key, entry.base) : [];
    const writes = hits.some((h) => h.access === "write");
    const target = logixBase(t.aliasFor);
    const where = { kind: "program" as const, owner: t.scope, routine: "" };
    const info = index.resolve(t.name, where);
    const p: IoPoint = {
      ref: t.name,
      where,
      label: t.scope ? `${t.scope}.${t.name}` : t.name,
      kind: /:O\b/.test(t.aliasFor) || (!/:I\b/.test(t.aliasFor) && writes) ? "output" : "input",
      usedInLogic: hits.length > 0,
    };
    const desc = (t.description ?? info.description)?.replace(/\s*\n\s*/g, " ");
    if (desc) p.description = `${desc}  ← ${t.aliasFor}`;
    else p.description = `← ${t.aliasFor}`;
    if (info.hasValue) p.value = info.value!;
    if (!groups.has(target)) groups.set(target, []);
    groups.get(target)!.push(p);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([target, points]) => {
      const base = index.resolve(target, anyScope(index));
      const g: IoGroup = { title: target, points: points.sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true })) };
      if (base.description) g.subtitle = base.description.replace(/\s*\n\s*/g, " ");
      return g;
    });
}

/* ---------------------------------- alarms ---------------------------------- */

export interface AlarmEntry {
  ref: string;
  where: Scope & { routine: string };
  label: string;
  description?: string;
  /** First line of the rung comment where it's set. */
  comment?: string;
  active: boolean | null;
  at: { where: RoutineRef; rung: number };
  how: string;
}

export const ALARM_WORDS = /alarm|fault|\bflt\b|fail|trip|overload|o\/l|emergency|\berror\b|\bjam\b|warn|overtemp|over temp|low level|high level/i;
/** E-stop, case-sensitive so words like "requESTOPen" don't match. */
export const ESTOP = /E-?Stop|E-?STOP|\be-stop\b/;

export function findAlarms(index: ProjectIndex): AlarmEntry[] {
  const out: AlarmEntry[] = [];
  for (const e of index.project.crossReference) {
    if (/[./](DN|TT|EN|ACC|PRE|CU|CD|OV|UN|ER)$/i.test(e.key)) continue;
    // HMI "visible" flags just show/hide a graphic.
    if (/[._]Visible\w*(\[\d+\])?$/i.test(e.key)) continue;
    const setter = e.hits.find((h) => h.kind === "program" && (h.mnemonic.toUpperCase() === "OTE" || h.mnemonic.toUpperCase() === "OTL"));
    if (!setter) continue;
    const where = { kind: setter.kind, owner: setter.owner, routine: setter.routine };
    const info = index.resolve(setter.address, where);
    if (info.dataType && info.dataType !== "BOOL" && !/^[BINO]/.test(info.dataType)) continue;
    const text = `${e.key} ${info.symbol ?? ""} ${info.description ?? ""}`;
    if (!ALARM_WORDS.test(text) && !ESTOP.test(text)) continue;
    const rung = index.routine(where)?.rungs.find((r) => r.index === setter.rung);
    const comment = rung?.comment
      ?.split("\n")
      .map((l) => l.trim())
      .find((l) => l && !/^[*=#\-_.]{4,}$/.test(l));
    const entry: AlarmEntry = {
      ref: setter.address,
      where,
      label: e.key.replace(/^(Program|AOI):[^.]+\./, ""),
      active: typeof info.value === "boolean" ? info.value : null,
      at: { where: { kind: setter.kind, owner: setter.owner, routine: setter.routine }, rung: setter.rung },
      how: setter.mnemonic.toUpperCase(),
    };
    if (info.description) entry.description = info.description.replace(/\s*\n\s*/g, " ");
    if (comment) entry.comment = comment.slice(0, 200);
    out.push(entry);
  }
  const rank = (a: AlarmEntry) => (a.active === true ? 0 : a.active === null ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, undefined, { numeric: true }));
}
