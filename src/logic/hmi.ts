/**
 * Tie an operator panel (FactoryTalk View ME) to the PLC program: which
 * screens show or write each PLC address, and which rungs raise each alarm
 * message.
 */

import type {
  HmiAccess,
  HmiAlarmTrigger,
  HmiObject,
  HmiObjectKind,
  HmiProject,
  LadderNode,
  RoutineRef,
} from "../model/types.js";
import type { ProjectIndex, Scope } from "../query/index.js";
import { isConstant } from "./refs.js";

const CONTROLLER: Scope = { kind: "program", owner: "" };

/** One place an address is used on a panel. */
export interface HmiUse {
  application: string;
  screen: string;
  object: string;
  type: string;
  kind: HmiObjectKind;
  access: HmiAccess;
  /** First caption, for a readable label ("SILENCE ALARM"). */
  caption?: string;
  expr: string;
  address: string;
  shortcut?: string;
  /** PLC key when the address belongs to this machine's PLC. */
  key?: string;
}

export interface HmiLinks {
  uses: HmiUse[];
  byKey: Map<string, HmiUse[]>;
  /** Shortcut names that point at this machine's PLC. */
  local: Set<string>;
}

/** The shortcut a panel uses most — on a one-PLC machine, that's this PLC. */
export function primaryShortcut(hmi: HmiProject): string | undefined {
  const counts = new Map<string, number>();
  for (const s of hmi.screens)
    for (const o of s.objects) for (const c of o.connections) for (const r of c.refs) if (r.shortcut) counts.set(r.shortcut, (counts.get(r.shortcut) ?? 0) + 1);
  for (const t of hmi.triggers) for (const r of t.refs) if (r.shortcut) counts.set(r.shortcut, (counts.get(r.shortcut) ?? 0) + 5);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function objectLabel(o: HmiObject): string {
  const caption = o.captions[0]?.replace(/\s*\n\s*/g, " ").trim();
  return caption ? caption : o.name;
}

/** Every panel connection, keyed by the PLC address it touches. */
export function hmiLinks(index: ProjectIndex): HmiLinks {
  const project = index.project;
  const hasLogic = project.programs.length > 0;
  const local = new Set<string>();
  const uses: HmiUse[] = [];
  const byKey = new Map<string, HmiUse[]>();
  for (const hmi of project.hmi ?? []) {
    const primary = primaryShortcut(hmi);
    if (primary) local.add(primary.toLowerCase());
    for (const screen of hmi.screens) {
      for (const o of screen.objects) {
        for (const c of o.connections) {
          for (const r of c.refs) {
            const use: HmiUse = {
              application: hmi.application,
              screen: screen.name,
              object: o.name,
              type: o.type,
              kind: o.kind,
              access: c.access,
              expr: c.expr,
              address: r.address,
            };
            const caption = objectLabel(o);
            if (caption !== o.name) use.caption = caption;
            if (r.shortcut) use.shortcut = r.shortcut;
            const isLocal = !!r.shortcut && local.has(r.shortcut.toLowerCase());
            if (isLocal && hasLogic) use.key = keyOf(index, r.address);
            uses.push(use);
            const k = use.key ?? `hmi:${r.address.toUpperCase()}`;
            const list = byKey.get(k);
            if (list) list.push(use);
            else byKey.set(k, [use]);
          }
        }
      }
    }
  }
  return { uses, byKey, local };
}

function keyOf(index: ProjectIndex, address: string): string {
  try {
    return index.resolve(address, CONTROLLER).key;
  } catch {
    return address.toUpperCase();
  }
}

/** Panel uses of one PLC tag / address (and its bits or members). */
export function hmiUsesFor(links: HmiLinks, key: string): HmiUse[] {
  const out: HmiUse[] = [...(links.byKey.get(key) ?? [])];
  for (const [k, list] of links.byKey) {
    if (k !== key && (k.startsWith(`${key}/`) || k.startsWith(`${key}.`) || k.startsWith(`${key}[`))) out.push(...list);
  }
  return out;
}

export const ACCESS_LABEL: Record<HmiAccess, string> = {
  write: "Panel writes",
  readwrite: "Entered on the panel",
  read: "Shown on the panel",
  animation: "Animates the panel",
};

/* --------------------------------- alarms --------------------------------- */

export interface AlarmRaiser {
  where: RoutineRef;
  rung: number;
  mnemonic: string;
  /** e.g. "MOV 12 → N22:26" */
  detail: string;
}

export interface HmiAlarmView {
  value: number;
  text: string;
  application: string;
  /** Trigger index from the file (0 = not attached). */
  triggerIndex: number;
  trigger?: HmiAlarmTrigger;
  /** PLC key of the trigger tag (when it's this machine's PLC). */
  key?: string;
  raisers: AlarmRaiser[];
}

function walk(node: LadderNode | undefined, visit: (mnemonic: string, operands: string[]) => void): void {
  if (!node) return;
  if (node.kind === "instruction") visit(node.mnemonic, node.operands);
  else if (node.kind === "series") node.elements.forEach((n) => walk(n, visit));
  else node.branches.forEach((n) => walk(n, visit));
}

function constantValue(operand: string): number | undefined {
  const t = operand.trim();
  if (!isConstant(t)) return undefined;
  const radix = t.match(/^([-+]?)(\d+)#([0-9A-Fa-f_]+)$/);
  if (radix) return Number.parseInt(radix[3]!.replace(/_/g, ""), Number(radix[2])) * (radix[1] === "-" ? -1 : 1);
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Writes of a constant into `key`: value → the rungs that do it. */
function constantWrites(index: ProjectIndex, key: string, base: string): Map<number, AlarmRaiser[]> {
  const out = new Map<number, AlarmRaiser[]>();
  const seen = new Set<string>();
  for (const hit of index.hitsRelated(key, base)) {
    if (hit.access !== "write") continue;
    const id = `${hit.kind}|${hit.owner}|${hit.routine}|${hit.rung}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const rung = index.routine(hit)?.rungs.find((r) => r.index === hit.rung);
    const where: Scope = { kind: hit.kind, owner: hit.owner };
    walk(rung?.ladder, (mnemonic, operands) => {
      const m = mnemonic.toUpperCase();
      // MOV source dest | MVM source mask dest | CLR dest
      let src: string | undefined;
      let dest: string | undefined;
      if (m === "MOV" || m === "COP" || m === "CPS" || m === "FLL") [src, dest] = operands;
      else if (m === "MVM") [src, , dest] = operands;
      else if (m === "CLR") [dest] = operands;
      if (!dest) return;
      if (keyOfIn(index, dest, where) !== key) return;
      const value = m === "CLR" ? 0 : src !== undefined ? constantValue(src) : undefined;
      if (value === undefined) return;
      const list = out.get(value) ?? [];
      list.push({ where: { kind: hit.kind, owner: hit.owner, routine: hit.routine }, rung: hit.rung, mnemonic: m, detail: `${m} ${src ?? ""} → ${dest}`.replace(/\s+/g, " ") });
      out.set(value, list);
    });
  }
  return out;
}

function keyOfIn(index: ProjectIndex, ref: string, where: Scope): string {
  try {
    return index.resolve(ref, where).key;
  } catch {
    return ref.toUpperCase();
  }
}

/** Every alarm message with its trigger and, when the PLC is loaded, the rungs that raise it. */
export function hmiAlarms(index: ProjectIndex, links = hmiLinks(index)): HmiAlarmView[] {
  const hasLogic = index.project.programs.length > 0;
  const out: HmiAlarmView[] = [];
  for (const hmi of index.project.hmi ?? []) {
    const writes = new Map<number, Map<number, AlarmRaiser[]>>();
    const keys = new Map<number, string>();
    for (const t of hmi.triggers) {
      const r = t.refs[0];
      if (!hasLogic || !r?.shortcut || !links.local.has(r.shortcut.toLowerCase())) continue;
      const info = index.resolve(r.address, CONTROLLER);
      keys.set(t.index, info.key);
      writes.set(t.index, constantWrites(index, info.key, info.base));
    }
    for (const m of hmi.messages) {
      const trigger = hmi.triggers.find((t) => t.index === m.trigger) ?? (hmi.triggers.length === 1 && m.trigger ? hmi.triggers[0] : undefined);
      const view: HmiAlarmView = { value: m.value, text: m.text, triggerIndex: m.trigger, application: hmi.application, raisers: [] };
      if (trigger) {
        view.trigger = trigger;
        const key = keys.get(trigger.index);
        if (key) view.key = key;
        view.raisers = writes.get(trigger.index)?.get(m.value) ?? [];
      }
      out.push(view);
    }
  }
  return out;
}

/** Address with its shortcut, as FactoryTalk shows it: [PLC]N7:0 */
export function formatHmiAddress(a: { shortcut?: string; address: string }): string {
  return a.shortcut ? `[${a.shortcut}]${a.address}` : a.address;
}

const linkCache = new WeakMap<ProjectIndex, HmiLinks>();

/** hmiLinks() once per loaded project. */
export function hmiLinksCached(index: ProjectIndex): HmiLinks {
  let links = linkCache.get(index);
  if (!links) {
    links = hmiLinks(index);
    linkCache.set(index, links);
  }
  return links;
}
