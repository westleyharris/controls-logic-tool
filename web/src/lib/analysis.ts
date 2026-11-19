import type { ProjectModel } from "@core/model/types";
import { ProjectIndex } from "@core/query/index";
import { machineComms, type MachineComms } from "@core/logic/connectivity";
import { partsOf, type PartEntry } from "@core/logic/parts";
import { findAlarms } from "@core/logic/overview";
import { buildSearchIndex, type SearchItem } from "./search";

/** Per-machine facts the library uses (network map, spare parts, search across machines). */
export interface AnalysisResult {
  comms: MachineComms;
  parts: PartEntry[];
  search: SearchItem[];
}

export function analyzeProject(project: ProjectModel, index = new ProjectIndex(project), search = buildSearchIndex(project)): AnalysisResult {
  const alarms: SearchItem[] = findAlarms(index).map((a) => ({
    kind: "alarm",
    label: a.label,
    detail: [a.description, a.comment && a.comment !== a.description ? a.comment : ""].filter(Boolean).join(" — ").slice(0, 140),
    haystack: `${a.label} ${a.description ?? ""} ${a.comment ?? ""} alarm`.toLowerCase(),
    go: { view: "routine", ref: a.at.where, rung: a.at.rung },
    select: { kind: "ref", ref: a.ref, where: a.where, rung: a.at.rung },
  }));
  return { comms: machineComms(index), parts: partsOf(project), search: [...alarms, ...search] };
}
