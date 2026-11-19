import type { RoutineRef } from "@core/model/types";
import { walkInstructions } from "@core/ladder/parse";
import type { ProjectIndex } from "@core/query/index";

export interface AoiCall {
  where: RoutineRef;
  rung: number;
  instance: string;
}

const cache = new WeakMap<ProjectIndex, Map<string, AoiCall[]>>();

/** Every place an AOI is called, with the instance tag each call uses. */
export function findAoiCalls(index: ProjectIndex, aoiName: string): AoiCall[] {
  let byAoi = cache.get(index);
  if (!byAoi) cache.set(index, (byAoi = new Map()));
  const upper = aoiName.toUpperCase();
  const hit = byAoi.get(upper);
  if (hit) return hit;
  const out: AoiCall[] = [];
  const scan = (kind: "program" | "aoi", owner: string, routines: { name: string; rungs: { index: number; ladder?: Parameters<typeof walkInstructions>[0] }[] }[]) => {
    for (const r of routines) {
      for (const rung of r.rungs) {
        if (!rung.ladder) continue;
        walkInstructions(rung.ladder, (ins) => {
          if (ins.mnemonic.toUpperCase() === upper) {
            out.push({ where: { kind, owner, routine: r.name }, rung: rung.index, instance: ins.operands[0] ?? "" });
          }
        });
      }
    }
  };
  for (const p of index.project.programs) scan("program", p.name, p.routines);
  for (const a of index.project.aois) scan("aoi", a.name, a.routines);
  byAoi.set(upper, out);
  return out;
}
