/**
 * "Why is this ON / OFF?" — find every rung that writes a signal, evaluate
 * each one against the saved values, and report what is (or isn't) driving it.
 * The UI expands blocking conditions into further traces on demand.
 */

import type { CrossReferenceHit, LadderNode, RoutineRef } from "../model/types.js";
import type { LadderInstruction } from "../ladder/ast.js";
import { walkInstructions } from "../ladder/parse.js";
import type { ProjectIndex, RefInfo, Scope } from "../query/index.js";
import { evaluateRung, type Blocker, type RungEvaluation, type Tri } from "./evaluate.js";
import { parseClassicAddress } from "./refs.js";

/** Status flags with a known value in a saved (non-first-scan) snapshot. */
const SNAPSHOT_FLAGS: Record<string, boolean> = { "S:FS": false };

const evalCache = new WeakMap<LadderNode, Map<string, RungEvaluation>>();

export function scopeKey(where: Scope): string {
  return JSON.stringify([where.kind, where.owner, where.instance ?? null]);
}

/** Power flow for one rung against the saved values, cached per rung and scope. */
export function evaluateInScope(root: LadderNode, index: ProjectIndex, where: Scope): RungEvaluation {
  let byScope = evalCache.get(root);
  if (!byScope) evalCache.set(root, (byScope = new Map()));
  const key = scopeKey(where);
  const hit = byScope.get(key);
  if (hit) return hit;
  const ev = evaluateRung(root, {
    value: (ref) => {
      const flag = SNAPSHOT_FLAGS[ref.trim().toUpperCase()];
      if (flag !== undefined) return flag;
      return index.resolve(ref, where).value;
    },
    isAoi: (m) => !!index.aoi(m),
  });
  byScope.set(key, ev);
  return ev;
}

export type WriterEffect = "drive" | "set" | "reset" | "timer" | "counter" | "value" | "aoi" | "other";

export interface TraceWriter {
  hit: CrossReferenceHit;
  where: RoutineRef;
  instruction: LadderInstruction;
  effect: WriterEffect;
  /** Does the instruction get power in the saved values? */
  energized: Tri;
  /** What keeps it from getting power (when not energized). */
  blockers: Blocker[];
  /** false when the instruction writes a whole parent structure (e.g. an AOI InOut or COP of the UDT). */
  direct: boolean;
}

export interface IoPoint {
  kind: "input" | "output";
  /** Human description of where it is, e.g. "Rack 0, group 4, terminal 7". */
  location: string;
}

export interface TraceResult {
  info: RefInfo;
  writers: TraceWriter[];
  io?: IoPoint;
}

function effectOf(mnemonic: string, isAoi: boolean): WriterEffect {
  const m = mnemonic.toUpperCase();
  if (m === "OTE") return "drive";
  if (m === "OTL") return "set";
  if (m === "OTU" || m === "RES" || m === "CLR") return "reset";
  if (["TON", "TOF", "RTO", "TONR", "TOFR", "RTOR"].includes(m)) return "timer";
  if (["CTU", "CTD", "CTUD"].includes(m)) return "counter";
  if (isAoi) return "aoi";
  if (["MOV", "MVM", "COP", "CPS", "FLL", "CPT", "ADD", "SUB", "MUL", "DIV", "MOD", "BTD", "AND", "OR", "XOR", "NOT", "NEG", "ABS", "SQR", "SCL", "SCP", "GSV", "FAL"].includes(m)) {
    return "value";
  }
  return "other";
}

/** Physical I/O behind an address, when it can be told from the address itself. */
export function ioPointOf(index: ProjectIndex, info: RefInfo): IoPoint | undefined {
  if (!index.isLogix) {
    const a = parseClassicAddress(info.key);
    if (!a || (a.type !== "I" && a.type !== "O") || a.element === undefined) return undefined;
    if (a.slot !== undefined) {
      const mod = index.project.modules.flatMap((m) => [m, ...m.children]).find((m) => m.slot === String(a.slot));
      const card = mod ? ` (${mod.catalogNumber}${mod.description ? ` — ${mod.description}` : ""})` : "";
      return {
        kind: a.type === "I" ? "input" : "output",
        location: `Slot ${a.slot}${card}, word ${a.element}${a.bit !== undefined ? `, bit ${a.bit}` : ""}`,
      };
    }
    const rack = Math.floor(a.element / 8);
    const group = a.element % 8;
    const where = `Rack ${rack.toString(8)}, group ${group}${a.bit !== undefined ? `, terminal ${a.bit.toString(8).padStart(2, "0")}` : ""}`;
    return { kind: a.type === "I" ? "input" : "output", location: where };
  }
  const target = info.aliasFor ?? info.key;
  const m = target.match(/^([A-Za-z_]\w*):(\d+):([IOC])\b(.*)$/);
  if (m) {
    const [, chassis, slot, dir, rest] = m;
    const mod = findModule(index, chassis!, slot!);
    const name = mod ? `${mod.name}${mod.catalogNumber ? ` (${mod.catalogNumber})` : ""}` : `${chassis} slot ${slot}`;
    return { kind: dir === "O" ? "output" : "input", location: `${name}, slot ${slot}${rest ? ` — ${rest.replace(/^\./, "")}` : ""}` };
  }
  return undefined;
}

function findModule(index: ProjectIndex, chassis: string, slot: string) {
  const walk = (list: typeof index.project.modules, parent?: string): (typeof index.project.modules)[number] | undefined => {
    for (const mod of list) {
      const inChassis = chassis === "Local" ? (mod.parent ?? "Local") === "Local" : mod.parent === chassis || parent === chassis;
      if (inChassis && String(mod.slot) === slot && mod.name !== "Local") return mod;
      const found = walk(mod.children, mod.name);
      if (found) return found;
    }
    return undefined;
  };
  return walk(index.project.modules);
}

/** Everything that writes `ref`, evaluated against the saved values. */
export function traceSignal(index: ProjectIndex, ref: string, where: Scope): TraceResult {
  const info = index.resolve(ref, where);
  const seen = new Set<string>();
  const writers: TraceWriter[] = [];

  for (const hit of index.hitsRelated(info.key, info.base)) {
    if (hit.access !== "write") continue;
    const id = `${hit.kind}|${hit.owner}|${hit.routine}|${hit.rung}|${hit.mnemonic}|${hit.address}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const routineRef: RoutineRef = { kind: hit.kind, owner: hit.owner, routine: hit.routine };
    const rung = index.routine(routineRef)?.rungs.find((r) => r.index === hit.rung);
    if (!rung?.ladder) continue;
    // Inside the same AOI we keep the instance so values resolve.
    const scope: Scope =
      hit.kind === "aoi" && where.kind === "aoi" && where.owner === hit.owner && where.instance
        ? { kind: hit.kind, owner: hit.owner, instance: where.instance }
        : { kind: hit.kind, owner: hit.owner };
    const ev = evaluateInScope(rung.ladder, index, scope);
    const hitKey = index.resolve(hit.address, scope).key;
    const exact = hitKey === info.key || [".", "[", "/"].some((sep) => hitKey.startsWith(info.key + sep));
    const matches: LadderInstruction[] = [];
    walkInstructions(rung.ladder, (ins) => {
      if (ins.mnemonic !== hit.mnemonic) return;
      if (ins.operands.some((op) => op.trim() === hit.address) || ins.operands.some((op) => op.includes(hit.address))) {
        matches.push(ins);
      }
    });
    for (const ins of matches) {
      const energized = ev.states.get(ins)?.in ?? null;
      const effect = effectOf(ins.mnemonic, !!index.aoi(ins.mnemonic));
      // A timer/counter instruction (or RES) on the parent structure is what drives .DN/.TT/.ACC…
      const direct = exact || effect === "timer" || effect === "counter" || ins.mnemonic.toUpperCase() === "RES";
      writers.push({
        hit,
        where: routineRef,
        instruction: ins,
        effect,
        energized,
        blockers: energized === true ? [] : ev.blockers(ins),
        direct,
      });
    }
  }

  const result: TraceResult = { info, writers };
  const io = ioPointOf(index, info);
  if (io) result.io = io;
  return result;
}
