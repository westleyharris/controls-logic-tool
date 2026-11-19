import type { ControllerInfo, ModuleNode, PlatformFamily, ProjectModel } from "./types.js";

export function emptyProject(
  name: string,
  platform: PlatformFamily,
  controller?: Partial<ControllerInfo>,
): ProjectModel {
  return {
    schemaVersion: 2,
    name,
    platform,
    controller: { name, family: platform, ...controller },
    sources: [],
    programs: [],
    tasks: [],
    modules: [],
    aois: [],
    dataTypes: [],
    tags: [],
    symbols: [],
    dataFiles: [],
    forces: [],
    crossReference: [],
    warnings: [],
    stats: {
      programCount: 0,
      routineCount: 0,
      rungCount: 0,
      tagCount: 0,
      symbolCount: 0,
      moduleCount: 0,
      aoiCount: 0,
      dataTypeCount: 0,
      dataFileCount: 0,
      forceCount: 0,
      xrefCount: 0,
    },
  };
}

export function countModules(nodes: ModuleNode[]): number {
  let n = 0;
  const walk = (list: ModuleNode[]) => {
    for (const m of list) {
      n += 1;
      walk(m.children);
    }
  };
  walk(nodes);
  return n;
}

export function finalizeProject(project: ProjectModel): ProjectModel {
  const routineCount = project.programs.reduce((a, p) => a + p.routines.length, 0);
  const rungCount = project.programs.reduce(
    (a, p) => a + p.routines.reduce((b, r) => b + r.rungs.length, 0),
    0,
  );
  project.stats = {
    programCount: project.programs.length,
    routineCount,
    rungCount,
    tagCount: project.tags.length,
    symbolCount: project.symbols.length,
    moduleCount: countModules(project.modules),
    aoiCount: project.aois.length,
    dataTypeCount: project.dataTypes.length,
    dataFileCount: project.dataFiles.length,
    forceCount: project.forces.length,
    xrefCount: project.crossReference.length,
  };
  return project;
}
