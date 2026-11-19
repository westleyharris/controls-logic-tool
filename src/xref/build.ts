import type {
  AoiDefinition,
  CrossReferenceEntry,
  CrossReferenceHit,
  ProjectModel,
  Routine,
  RoutineRef,
} from "../model/types.js";
import { walkInstructions } from "../ladder/parse.js";
import { canonicalClassic, classicBase, operandRefs, operandWrites, type Dialect } from "../logic/refs.js";

/** Splits a Logix reference into its root tag name and the remaining path. */
export function splitLogixRef(ref: string): { root: string; rest: string } {
  const m = ref.match(/^([A-Za-z_][\w]*(?::[\w]+)*)(.*)$/);
  if (!m) return { root: ref, rest: "" };
  return { root: m[1]!, rest: m[2]! };
}

export interface ScopeTables {
  controller: Map<string, string>;
  programs: Map<string, Map<string, string>>;
  aois: Map<string, Map<string, string>>;
}

export function buildScopeTables(project: ProjectModel): ScopeTables {
  const controller = new Map<string, string>();
  const programs = new Map<string, Map<string, string>>();
  for (const t of project.tags) {
    if (!t.scope) controller.set(t.name.toUpperCase(), t.name);
    else {
      let m = programs.get(t.scope);
      if (!m) programs.set(t.scope, (m = new Map()));
      m.set(t.name.toUpperCase(), t.name);
    }
  }
  const aois = new Map<string, Map<string, string>>();
  for (const a of project.aois) {
    const m = new Map<string, string>();
    for (const t of [...a.parameters, ...a.localTags]) m.set(t.name.toUpperCase(), t.name);
    aois.set(a.name, m);
  }
  return { controller, programs, aois };
}

/**
 * Canonical cross-reference key for a Logix reference used inside `where`.
 * Program-scoped tags become `Program:<name>.<tag>…`; AOI-internal tags `AOI:<name>.<tag>…`.
 */
export function logixKey(ref: string, where: Pick<RoutineRef, "kind" | "owner">, scopes: ScopeTables): {
  key: string;
  base: string;
} {
  if (/^Program:/i.test(ref)) {
    const m = ref.match(/^Program:([A-Za-z_]\w*)\.(.*)$/i);
    if (m) {
      const { root, rest } = splitLogixRef(m[2]!);
      const base = `Program:${m[1]}.${root}`;
      return { key: base + rest, base };
    }
  }
  const { root, rest } = splitLogixRef(ref);
  const upper = root.toUpperCase();
  if (where.kind === "aoi") {
    const declared = scopes.aois.get(where.owner)?.get(upper);
    if (declared) {
      const base = `AOI:${where.owner}.${declared}`;
      return { key: base + rest, base };
    }
  } else {
    const declared = scopes.programs.get(where.owner)?.get(upper);
    if (declared) {
      const base = `Program:${where.owner}.${declared}`;
      return { key: base + rest, base };
    }
  }
  const declared = scopes.controller.get(upper) ?? root;
  return { key: declared + rest, base: declared };
}

function aoiArgAccess(aoi: AoiDefinition, argIndex: number): "read" | "write" {
  if (argIndex === 0) return "write"; // the instance tag
  const required = aoi.parameters.filter(
    (p) => p.required || p.usage?.toLowerCase() === "inout",
  );
  const param = required[argIndex - 1];
  const usage = param?.usage?.toLowerCase();
  return usage === "output" || usage === "inout" ? "write" : "read";
}

export function buildCrossReference(project: ProjectModel): CrossReferenceEntry[] {
  const dialect: Dialect = project.platform === "logix" ? "logix" : "classic";
  const scopes = dialect === "logix" ? buildScopeTables(project) : undefined;
  const aoiByName = new Map(project.aois.map((a) => [a.name.toUpperCase(), a]));
  const entries = new Map<string, CrossReferenceEntry>();

  const visitRoutine = (where: Omit<RoutineRef, "routine">, routine: Routine) => {
    for (const rung of routine.rungs) {
      if (!rung.ladder) continue;
      walkInstructions(rung.ladder, (ins) => {
        const aoi = dialect === "logix" ? aoiByName.get(ins.mnemonic.toUpperCase()) : undefined;
        ins.operands.forEach((operand, idx) => {
          const refs = operandRefs(ins.mnemonic, idx, operand, dialect);
          if (refs.length === 0) return;
          const access: "read" | "write" = aoi
            ? aoiArgAccess(aoi, idx)
            : operandWrites(ins.mnemonic, idx)
              ? "write"
              : "read";
          refs.forEach((ref, k) => {
            let key: string;
            let base: string;
            if (scopes) ({ key, base } = logixKey(ref, where, scopes));
            else {
              key = canonicalClassic(ref);
              base = classicBase(key);
            }
            const hit: CrossReferenceHit = {
              ...where,
              routine: routine.name,
              rung: rung.index,
              address: ref,
              mnemonic: ins.mnemonic,
              // Index tags inside an array subscript are only read.
              access: k === 0 ? access : "read",
            };
            let entry = entries.get(key);
            if (!entry) entries.set(key, (entry = { key, base, hits: [] }));
            entry.hits.push(hit);
          });
        });
      });
    }
  };

  for (const program of project.programs) {
    for (const routine of program.routines) visitRoutine({ kind: "program", owner: program.name }, routine);
  }
  for (const aoi of project.aois) {
    for (const routine of aoi.routines) visitRoutine({ kind: "aoi", owner: aoi.name }, routine);
  }

  return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}
