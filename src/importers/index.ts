import { finalizeProject } from "../model/factory.js";
import type { InputFile, ProjectModel, SourceFile, SourceFormat } from "../model/types.js";
import { buildCrossReference } from "../xref/build.js";
import { parseL5kText } from "./l5k.js";
import { parseL5xText } from "./l5x.js";
import { parsePc5Text } from "./pc5.js";
import { parseSy6Text } from "./sy6.js";

export { parsePc5Text } from "./pc5.js";
export { parseL5kText } from "./l5k.js";
export { parseL5xText } from "./l5x.js";
export { parseSy6Text } from "./sy6.js";

const EXT_FORMAT: Record<string, SourceFormat> = {
  pc5: "pc5",
  sy5: "sy5",
  sy6: "sy6",
  l5k: "l5k",
  l5x: "l5x",
  slc: "slc",
  csv: "csv",
};

export function formatOf(name: string): SourceFormat {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_FORMAT[ext] ?? "unknown";
}

/** File extensions the drop zone accepts. */
export const ACCEPTED_EXTENSIONS = [".pc5", ".sy6", ".sy5", ".l5k", ".l5x", ".slc", ".csv"];

export class ImportError extends Error {}

/**
 * Turn dropped / selected export files into a project.
 * Pure: no file system or DOM access, so it runs in a Web Worker or Node.
 */
export function importFiles(files: InputFile[]): ProjectModel {
  const byFormat = (f: SourceFormat) => files.filter((x) => formatOf(x.name) === f);
  const sources: SourceFile[] = files.map((f) => ({
    name: f.name,
    format: formatOf(f.name),
    role: "other",
    size: f.text.length,
  }));
  const markRole = (name: string, role: SourceFile["role"]) => {
    const s = sources.find((x) => x.name === name);
    if (s) s.role = role;
  };

  let project: ProjectModel;
  const pc5 = byFormat("pc5")[0];
  const l5k = byFormat("l5k")[0];
  const l5x = byFormat("l5x")[0];
  const slc = byFormat("slc")[0];

  if (pc5) {
    project = parsePc5Text(pc5.text, pc5.name);
    markRole(pc5.name, "logic");
    const sym = byFormat("sy6")[0] ?? byFormat("sy5")[0];
    if (sym) {
      project.symbols = parseSy6Text(sym.text);
      markRole(sym.name, "symbols");
    } else {
      project.warnings.push("No .SY6/.SY5 symbol file was included — addresses will show without descriptions.");
    }
  } else if (l5k) {
    project = parseL5kText(l5k.text, l5k.name);
    markRole(l5k.name, "logic");
  } else if (l5x) {
    try {
      project = parseL5xText(l5x.text, l5x.name);
    } catch (err) {
      throw new ImportError(err instanceof Error ? err.message : String(err));
    }
    markRole(l5x.name, "logic");
  } else if (slc) {
    project = parsePc5Text(slc.text, slc.name, "slc");
    markRole(slc.name, "logic");
    project.warnings.push(
      "The .SLC export doesn't include address descriptions (RSLogix 500 keeps them in its documentation database), so addresses show without descriptions.",
    );
  } else {
    const names = files.map((f) => f.name).join(", ") || "(none)";
    throw new ImportError(
      `No PLC export found. Pick a .PC5 (with its .SY6), a .SLC, a .L5K or a .L5X file. Received: ${names}`,
    );
  }

  project.sources = sources;
  project.crossReference = buildCrossReference(project);
  return finalizeProject(project);
}
