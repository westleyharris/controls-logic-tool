/**
 * Read-side helpers over a ProjectModel: resolve any address / tag used in
 * a rung to its description, data type, saved value and force state, and
 * look up cross-reference hits. Built once per loaded project.
 */

import type {
  AoiDefinition,
  CrossReferenceEntry,
  CrossReferenceHit,
  DataFile,
  DataTypeDef,
  Program,
  ProjectModel,
  Routine,
  RoutineRef,
  SavedValue,
  SymbolRecord,
  TagRecord,
} from "../model/types.js";
import { canonicalClassic, classicBase, parseClassicAddress } from "../logic/refs.js";
import { buildScopeTables, logixKey, splitLogixRef, type ScopeTables } from "../xref/build.js";
import { walkInstructions } from "../ladder/parse.js";

/** Viewing an AOI's logic "through" one instance: its tag and where it's called from. */
export interface AoiInstance {
  tag: string;
  caller: Scope;
}

/** Where a reference is used. Inside an AOI, an instance gives the values. */
export type Scope = Pick<RoutineRef, "kind" | "owner"> & { instance?: AoiInstance };

export interface RefInfo {
  /** Reference exactly as written in the rung. */
  ref: string;
  key: string;
  base: string;
  scope: string;
  /** PLC-5 symbol or declared Logix tag name. */
  symbol?: string;
  description?: string;
  dataType?: string;
  value?: SavedValue;
  hasValue: boolean;
  forced?: "on" | "off";
  tag?: TagRecord;
  aliasFor?: string;
  /** Inside an AOI viewed through an instance: the real tag path the value came from. */
  instancePath?: string;
}

type Segment = { kind: "member"; name: string } | { kind: "index"; indices: string[] } | { kind: "bit"; bit: number };

export function parsePath(rest: string): Segment[] {
  const out: Segment[] = [];
  for (const m of rest.matchAll(/\.([A-Za-z_]\w*)|\.(\d+)|\[([^\]]+)\]/g)) {
    if (m[1]) out.push({ kind: "member", name: m[1] });
    else if (m[2]) out.push({ kind: "bit", bit: Number(m[2]) });
    else out.push({ kind: "index", indices: m[3]!.split(",").map((s) => s.trim()) });
  }
  return out;
}

const BUILTIN_MEMBERS: Record<string, Record<string, string>> = {
  TIMER: { PRE: "DINT", ACC: "DINT", EN: "BOOL", TT: "BOOL", DN: "BOOL" },
  COUNTER: { PRE: "DINT", ACC: "DINT", CU: "BOOL", CD: "BOOL", DN: "BOOL", OV: "BOOL", UN: "BOOL" },
  CONTROL: {
    LEN: "DINT",
    POS: "DINT",
    EN: "BOOL",
    EU: "BOOL",
    DN: "BOOL",
    EM: "BOOL",
    ER: "BOOL",
    UL: "BOOL",
    IN: "BOOL",
    FD: "BOOL",
  },
  STRING: { LEN: "DINT", DATA: "SINT" },
};

const PLC5_FIELDS: Record<string, { bits: Record<string, number>; words: Record<string, number> }> = {
  T: { bits: { EN: 15, TT: 14, DN: 13 }, words: { CTL: 0, PRE: 1, ACC: 2 } },
  C: { bits: { CU: 15, CD: 14, DN: 13, OV: 12, UN: 11, UA: 10 }, words: { CTL: 0, PRE: 1, ACC: 2 } },
  R: {
    bits: { EN: 15, EU: 14, DN: 13, EM: 12, ER: 11, UL: 10, IN: 9, FD: 8 },
    words: { CTL: 0, LEN: 1, POS: 2 },
  },
  BT: {
    bits: { EN: 15, ST: 14, DN: 13, ER: 12, CO: 11, EW: 10, NR: 9, TO: 8 },
    words: { CTL: 0, RLEN: 1, DLEN: 2, FILE: 3, ELEM: 4, RGS: 5 },
  },
};

function bitOf(word: number, bit: number): boolean {
  return ((word >>> bit) & 1) === 1;
}

export class ProjectIndex {
  readonly project: ProjectModel;
  readonly isLogix: boolean;
  private scopes?: ScopeTables;
  private tagsByScope = new Map<string, Map<string, TagRecord>>();
  private dataTypes = new Map<string, DataTypeDef>();
  private aois = new Map<string, AoiDefinition>();
  private symbols = new Map<string, SymbolRecord>();
  private files = new Map<string, DataFile>();
  private forces = new Map<string, "on" | "off">();
  private xrefByKey = new Map<string, CrossReferenceEntry>();
  private xrefByBase = new Map<string, CrossReferenceEntry[]>();

  constructor(project: ProjectModel) {
    this.project = project;
    this.isLogix = project.platform === "logix";
    if (this.isLogix) this.scopes = buildScopeTables(project);
    for (const t of project.tags) {
      let m = this.tagsByScope.get(t.scope);
      if (!m) this.tagsByScope.set(t.scope, (m = new Map()));
      m.set(t.name.toUpperCase(), t);
    }
    for (const d of project.dataTypes) this.dataTypes.set(d.name.toUpperCase(), d);
    for (const a of project.aois) {
      this.aois.set(a.name.toUpperCase(), a);
      const m = new Map<string, TagRecord>();
      for (const t of [...a.parameters, ...a.localTags]) m.set(t.name.toUpperCase(), t);
      this.tagsByScope.set(`AOI:${a.name}`, m);
    }
    for (const s of project.symbols) this.symbols.set(s.address, s);
    for (const f of project.dataFiles) this.files.set(f.name, f);
    for (const f of project.forces) this.forces.set(f.address, f.state);
    for (const e of project.crossReference) {
      this.xrefByKey.set(e.key, e);
      const list = this.xrefByBase.get(e.base);
      if (list) list.push(e);
      else this.xrefByBase.set(e.base, [e]);
    }
  }

  /* ------------------------------ structure ------------------------------ */

  program(name: string): Program | undefined {
    return this.project.programs.find((p) => p.name === name);
  }

  aoi(name: string): AoiDefinition | undefined {
    return this.aois.get(name.toUpperCase());
  }

  dataType(name: string): DataTypeDef | undefined {
    return this.dataTypes.get(name.toUpperCase());
  }

  routine(ref: RoutineRef): Routine | undefined {
    const owner = ref.kind === "aoi" ? this.aoi(ref.owner) : this.program(ref.owner);
    return owner?.routines.find((r) => r.name === ref.routine);
  }

  /** Target of a JSR operand list, if it can be resolved. */
  jsrTarget(operands: string[], from: RoutineRef): RoutineRef | undefined {
    const first = operands[0]?.trim();
    if (!first) return undefined;
    if (this.isLogix) {
      const owner = from.kind === "aoi" ? this.aoi(from.owner) : this.program(from.owner);
      const r = owner?.routines.find((x) => x.name.toUpperCase() === first.toUpperCase());
      return r ? { kind: from.kind, owner: from.owner, routine: r.name } : undefined;
    }
    const num = Number(first.replace(/^U:/i, ""));
    const p = this.project.programs.find((x) => x.number === num);
    const r = p?.routines[0];
    return p && r ? { kind: "program", owner: p.name, routine: r.name } : undefined;
  }

  /* ------------------------------ cross ref ------------------------------ */

  entry(key: string): CrossReferenceEntry | undefined {
    return this.xrefByKey.get(key);
  }

  /** All hits for the base tag / element (e.g. `T4:13`, its `/DN` and `.ACC`). */
  hitsForBase(base: string): CrossReferenceHit[] {
    return (this.xrefByBase.get(base) ?? []).flatMap((e) => e.hits);
  }

  hitsForKey(key: string): CrossReferenceHit[] {
    return this.xrefByKey.get(key)?.hits ?? [];
  }

  /**
   * Hits that matter for one tag / address: every use of it and its members,
   * plus instructions that write a parent structure (TON on T4:1 drives T4:1/DN;
   * COP into a UDT changes its members).
   */
  hitsRelated(key: string, base: string): CrossReferenceHit[] {
    const out: CrossReferenceHit[] = [];
    for (const e of this.xrefByBase.get(base) ?? []) {
      if (e.key === key || e.key.startsWith(`${key}.`) || e.key.startsWith(`${key}[`) || e.key.startsWith(`${key}/`)) {
        out.push(...e.hits);
      }
    }
    let parent = key;
    for (;;) {
      const next = parent.replace(/(\.[^.[\]/]+|\[[^\]]*\]|\/\w+)$/, "");
      if (next === parent || next.length < base.length) break;
      parent = next;
      for (const h of this.xrefByKey.get(parent)?.hits ?? []) if (h.access === "write") out.push(h);
    }
    return out;
  }

  /* ------------------------------ resolution ----------------------------- */

  resolve(ref: string, where: Scope): RefInfo {
    if (!this.isLogix) return this.resolveClassic(ref);
    const inner = this.resolveLogix(ref, where);
    if (where.kind !== "aoi" || !where.instance || !inner.base.startsWith("AOI:") || !inner.tag) return inner;

    // AOI parameter / local tag seen through an instance: read the instance's data
    // (or, for InOut parameters, whatever tag the call passes in).
    const { rest } = splitLogixRef(ref);
    let target: string | undefined;
    if (inner.tag.usage?.toLowerCase() === "inout") {
      target = this.aoiArgs(where.owner, where.instance)[inner.tag.name.toUpperCase()];
      if (target) target += rest;
    } else {
      target = `${where.instance.tag}.${inner.tag.name}${rest}`;
    }
    if (!target) return inner;
    const outer = this.resolve(target, where.instance.caller);
    const merged: RefInfo = { ...inner, hasValue: outer.hasValue, instancePath: outer.key };
    if (outer.value !== undefined) merged.value = outer.value;
    else delete merged.value;
    if (outer.forced) merged.forced = outer.forced;
    return merged;
  }

  private argCache = new Map<string, Record<string, string>>();

  /** Map an AOI's required / InOut parameters to the operands of the call that uses `instance`. */
  aoiArgs(aoiName: string, instance: AoiInstance): Record<string, string> {
    const key = `${aoiName}|${instance.tag}|${instance.caller.kind}:${instance.caller.owner}`;
    const cached = this.argCache.get(key);
    if (cached) return cached;
    const out: Record<string, string> = {};
    const aoi = this.aoi(aoiName);
    const owner = instance.caller.kind === "aoi" ? this.aoi(instance.caller.owner) : this.program(instance.caller.owner);
    if (aoi && owner) {
      const params = aoi.parameters.filter((p) => p.required || p.usage?.toLowerCase() === "inout");
      const upper = aoi.name.toUpperCase();
      const inst = instance.tag.toUpperCase();
      let found = false;
      for (const r of owner.routines) {
        for (const rung of r.rungs) {
          if (found || !rung.ladder) continue;
          walkInstructions(rung.ladder, (ins) => {
            if (found || ins.mnemonic.toUpperCase() !== upper || ins.operands[0]?.toUpperCase() !== inst) return;
            found = true;
            params.forEach((p, i) => {
              const op = ins.operands[i + 1];
              if (op !== undefined) out[p.name.toUpperCase()] = op;
            });
          });
        }
      }
    }
    this.argCache.set(key, out);
    return out;
  }

  private resolveClassic(ref: string): RefInfo {
    const key = canonicalClassic(ref);
    const base = classicBase(key);
    const info: RefInfo = { ref, key, base, scope: "Data table", hasValue: false };
    const sym = this.symbols.get(key) ?? (base !== key ? this.symbols.get(base) : undefined);
    if (sym?.symbol) info.symbol = sym.symbol;
    if (sym?.description) info.description = sym.description;
    const forced = this.forces.get(key);
    if (forced) info.forced = forced;

    const a = parseClassicAddress(key);
    if (!a) return info;
    info.dataType = a.type;
    const file = this.files.get(a.file);
    const el = a.element !== undefined ? file?.elements[a.element] : undefined;
    if (el === undefined) return info;

    if (Array.isArray(el)) {
      const layout = PLC5_FIELDS[a.type];
      if (!layout || el.length === 0) return info;
      if (a.member) {
        const bit = layout.bits[a.member];
        const word = layout.words[a.member];
        if (bit !== undefined) {
          info.value = bitOf(el[0] ?? 0, bit);
          info.dataType = "BOOL";
        } else if (word !== undefined && el[word] !== undefined) {
          info.value = el[word]!;
        } else return info;
      } else if (a.bit !== undefined) {
        info.value = bitOf(el[0] ?? 0, a.bit);
      } else {
        const obj: Record<string, SavedValue> = {};
        for (const [name, bit] of Object.entries(layout.bits)) obj[name] = bitOf(el[0] ?? 0, bit);
        for (const [name, idx] of Object.entries(layout.words)) if (name !== "CTL") obj[name] = el[idx] ?? 0;
        info.value = obj;
      }
      info.hasValue = true;
      return info;
    }

    if (typeof el === "string") {
      info.value = el;
      info.dataType = "ST";
    } else if (a.bit !== undefined) {
      info.value = bitOf(el, a.bit);
      info.dataType = "BOOL";
    } else {
      info.value = el;
    }
    info.hasValue = true;
    return info;
  }

  private findTag(base: string, where: Scope): TagRecord | undefined {
    const pm = base.match(/^(Program|AOI):([^.]+)\.(.+)$/);
    if (pm) {
      const scope = pm[1] === "AOI" ? `AOI:${pm[2]}` : pm[2]!;
      return this.tagsByScope.get(scope)?.get(pm[3]!.toUpperCase());
    }
    void where;
    return this.tagsByScope.get("")?.get(base.toUpperCase());
  }

  private resolveLogix(ref: string, where: Scope, depth = 0): RefInfo {
    const scopes = this.scopes!;
    const { key, base } = logixKey(ref, where, scopes);
    const scope = base.startsWith("Program:")
      ? `Program: ${base.split(".")[0]!.slice(8)}`
      : base.startsWith("AOI:")
        ? `AOI: ${base.split(".")[0]!.slice(4)}`
        : "Controller";
    const info: RefInfo = { ref, key, base, scope, hasValue: false };
    const tag = this.findTag(base, where);
    if (!tag) {
      if (/^S:/i.test(ref)) info.description = STATUS_SHORTCUTS[ref.toUpperCase()];
      return info;
    }
    info.tag = tag;
    info.symbol = tag.name;
    const { rest } = splitLogixRef(key.replace(/^(Program|AOI):[^.]+\./, ""));
    const path = parsePath(rest);

    if (tag.aliasFor && depth < 4) {
      const target = this.resolveLogix(tag.aliasFor + rest, where, depth + 1);
      info.aliasFor = tag.aliasFor;
      info.dataType = target.dataType;
      info.value = target.value;
      info.hasValue = target.hasValue;
      info.description = tag.description ?? target.description;
      return info;
    }

    const typed = this.walkType(tag, path);
    info.dataType = typed.dataType;
    info.description = typed.description ?? tag.description;
    if (tag.value !== undefined) {
      const v = walkValue(tag.value, tag.dims, path);
      if (v !== undefined) {
        info.value = v;
        info.hasValue = true;
      }
    }
    return info;
  }

  private walkType(tag: TagRecord, path: Segment[]): { dataType?: string; description?: string } {
    let type = tag.dataType;
    let dims = tag.dims?.length ?? 0;
    let description: string | undefined = tag.description;
    const memberPath: string[] = [];
    for (const seg of path) {
      if (seg.kind === "index") {
        dims = 0;
        memberPath.push(`[${seg.indices.join(",")}]`);
        continue;
      }
      if (seg.kind === "bit") {
        type = "BOOL";
        description = description ? `${description} — bit ${seg.bit}` : `Bit ${seg.bit}`;
        continue;
      }
      if (dims > 0) return { dataType: type, description };
      memberPath.push(`.${seg.name}`);
      const upper = seg.name.toUpperCase();
      const comment = tag.memberDescriptions?.[memberPath.join("").replace(/^\./, "").toUpperCase()];
      const builtin = BUILTIN_MEMBERS[type.toUpperCase()]?.[upper];
      if (builtin) {
        type = builtin;
        description = comment ?? description;
        continue;
      }
      const udt = this.dataTypes.get(type.toUpperCase());
      const aoi = this.aois.get(type.toUpperCase());
      const member = udt
        ? udt.members.find((m) => m.name.toUpperCase() === upper)
        : aoi
          ? [...aoi.parameters, ...aoi.localTags].find((m) => m.name.toUpperCase() === upper)
          : undefined;
      if (!member) return { dataType: undefined, description: comment ?? description };
      type = member.dataType;
      dims = "dims" in member && member.dims ? (Array.isArray(member.dims) ? member.dims.length : 1) : 0;
      description = comment ?? member.description ?? description;
    }
    return { dataType: dims > 0 ? `${type}[]` : type, description };
  }
}

function walkValue(value: SavedValue, dims: number[] | undefined, path: Segment[]): SavedValue | undefined {
  let v: SavedValue | undefined = value;
  let d = dims;
  for (const seg of path) {
    if (v === undefined) return undefined;
    if (seg.kind === "index") {
      if (!Array.isArray(v)) return undefined;
      const idx = seg.indices.map(Number);
      if (idx.some((n) => !Number.isInteger(n))) return undefined;
      let flat = 0;
      if (d && d.length === idx.length && idx.length > 1) {
        for (let k = 0; k < idx.length; k++) flat = flat * d[k]! + idx[k]!;
      } else flat = idx[0]!;
      v = v[flat];
      d = undefined;
      continue;
    }
    if (seg.kind === "bit") {
      if (typeof v !== "number") return undefined;
      v = bitOf(v, seg.bit);
      continue;
    }
    if (typeof v !== "object" || Array.isArray(v)) return undefined;
    const obj: { [k: string]: SavedValue } = v;
    const upper = seg.name.toUpperCase();
    const k = Object.keys(obj).find((x) => x.toUpperCase() === upper);
    v = k !== undefined ? obj[k] : undefined;
  }
  return v;
}

const STATUS_SHORTCUTS: Record<string, string> = {
  "S:FS": "First scan — on for the first scan after going to Run",
  "S:N": "Status: last math result negative",
  "S:Z": "Status: last math result zero",
  "S:V": "Status: last math result overflowed",
  "S:C": "Status: last math result carry",
  "S:MINOR": "Status: minor fault present",
};

/** Short display form of a saved value. */
export function formatValue(value: SavedValue | undefined, maxLen = 40): string {
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return String(value);
    const s = Number(value.toPrecision(7)).toString();
    return s;
  }
  if (typeof value === "string") return `'${value.length > maxLen ? `${value.slice(0, maxLen)}…` : value}'`;
  if (Array.isArray(value)) return `[${value.length} elements]`;
  const keys = Object.keys(value);
  return `{${keys.length} members}`;
}
