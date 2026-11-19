import { emptyProject } from "../model/factory.js";
import type { DataFile, ForceEntry, ModuleNode, Program, ProjectModel, Rung } from "../model/types.js";
import { parseClassicLadder } from "../ladder/parse.js";
import { formatClassicAddress } from "../logic/refs.js";

/**
 * RSLogix 5 ASCII export (.PC5).
 *
 *   START PLC5_20 SERIES_E REV_B COMPLETE
 *   DATA N7:161          ← data tables with values as saved
 *   PROJECT "NAME"       ← program file names
 *   LADDER 2             ← program file
 *   % Rung: 0 %
 *   SOR … EOR
 *   % TITLE/RUNG DESCRIPTION  ATTACHED TO:RUNG   ← comment for the rung ABOVE
 *   FORCE FO:037         ← force tables (ON mask, OFF mask per word)
 *   CONFIG …
 */

const STRUCT_FIELDS: Record<string, string[]> = {
  T: [".CTL", ".PRE", ".ACC"],
  C: [".CTL", ".PRE", ".ACC"],
  R: [".CTL", ".LEN", ".POS"],
  BT: [".CTL", ".RLEN", ".DLEN", ".FILE", ".ELEM", ".RGS"],
};

function parseHeader(line: string) {
  const m = line.match(/^START\s+(\S+)(?:\s+SERIES_(\S+))?(?:\s+REV_(\S+))?/i);
  if (!m) return {};
  return { processorType: m[1], series: m[2], revision: m[3] };
}

function parseWord(token: string): number {
  if (/^0X/i.test(token)) return parseInt(token.slice(2), 16);
  return Number(token);
}

function fileType(label: string): { type: string; number?: number } {
  const m = label.match(/^([A-Z]+)(\d*)$/);
  if (!m) return { type: label };
  return m[2] ? { type: m[1]!, number: Number(m[2]) } : { type: m[1]! };
}

/** Section headers. Strict patterns: rung comments often start with words like "START". */
function isSectionStart(line: string): boolean {
  return (
    /^DATA\s+[A-Z]+\d*:\d+\s*$/.test(line) ||
    /^LADDER\s+\d+\s*$/.test(line) ||
    /^PROJECT\s+"/.test(line) ||
    /^FORCE\s+F[A-Z]*\d*:\d+\s*$/.test(line) ||
    /^CONFIG\s+\S+:\d+\s*$/.test(line) ||
    /^(RACK|SLOT)\s+\d+\s/.test(line) ||
    /^START\s+PLC\S*\s/.test(line) ||
    /^END\s*$/.test(line)
  );
}

type Flavor = "plc5" | "slc";

/** A data-table row: "% N7:10 % 1 2 3" (values after the label) or "0XA04A 100 0 % T4:0 %" (SLC structures). */
function dataRow(line: string): { label: string; values: string } | null {
  let m = line.match(/^%\s*([A-Z]+\d*:[\d.]+)\s*%\s*(.*)$/);
  if (m) return { label: m[1]!, values: m[2]! };
  m = line.match(/^\s*(\S.*?)\s*%\s*([A-Z]+\d*:[\d.]+)\s*%\s*$/);
  if (m && !/^%/.test(m[1]!)) return { label: m[2]!, values: m[1]! };
  return null;
}

function parseDataSection(lines: string[], start: number, flavor: Flavor): { file: DataFile; end: number } {
  const header = lines[start]!.trim();
  const m = header.match(/^DATA\s+([A-Z]+\d*):(\d+)/);
  const fileLabel = m?.[1] ?? "?";
  const { type, number } = fileType(fileLabel);
  const io = type === "I" || type === "O";
  // SLC: "DATA I:2" is the I/O image of slot 2. PLC-5: "DATA I:037" is the whole (octal) image.
  const slcSlot = flavor === "slc" && io ? Number(m?.[2] ?? 0) : undefined;
  const name = slcSlot !== undefined ? `${type}:${slcSlot}` : fileLabel;
  const fields = STRUCT_FIELDS[type];
  const elements: (number | number[] | string)[] = [];

  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (isSectionStart(line)) break;
    const row = dataRow(line);
    if (!row) continue;
    const idx = row.label.split(":")[1] ?? "0";
    const at = slcSlot !== undefined ? Number(idx.split(".")[1] ?? 0) : io ? parseInt(idx, 8) : Number(idx);
    const raw = row.values.trim();
    // String files: the text is on the following line in quotes.
    if (!raw && /^\s*"/.test(lines[i + 1] ?? "")) {
      elements[at] = (lines[i + 1] ?? "").trim().replace(/^"|"$/g, "");
      i += 1;
      continue;
    }
    const values = raw
      .split(/\s+/)
      .filter((t) => t && t !== "----")
      .map(parseWord);
    if (fields) elements[at] = values;
    else values.forEach((v, k) => (elements[at + k] = v));
  }

  // Fill gaps so indexes line up.
  for (let k = 0; k < elements.length; k++) {
    if (elements[k] === undefined) elements[k] = fields ? [] : 0;
  }

  const file: DataFile = { name, type, elements };
  if (slcSlot !== undefined) file.number = slcSlot;
  else if (number !== undefined) file.number = number;
  if (fields) file.fields = fields;
  return { file, end: i };
}

function parseForceSection(lines: string[], start: number, flavor: Flavor): { forces: ForceEntry[]; end: number } {
  const header = lines[start]!.trim();
  const io = header.match(/^FORCE\s+F?([IO]):/)?.[1];
  const forces: ForceEntry[] = [];
  let i = start + 1;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (isSectionStart(line)) break;
    if (!io) continue;
    const row = line.match(/^\s*(0X[0-9A-F]+)\s+(0X[0-9A-F]+)\s*%\s*(?:FORCE\s+)?F?[IO]:([\d.]+)\s*%/i);
    if (!row) continue;
    const a = parseInt(row[1]!.slice(2), 16);
    const b = parseInt(row[2]!.slice(2), 16);
    if (flavor === "slc") {
      // SLC: first word = forced value, second = mask of bits that are NOT forced (0xFFFF = none).
      const [slot, word] = row[3]!.split(".").map(Number);
      const forced = ~b & 0xffff;
      for (let bit = 0; bit < 16; bit++) {
        if (!(forced & (1 << bit))) continue;
        const address = formatClassicAddress({ file: `${io}:${slot}`, type: io, slot: slot!, element: word ?? 0, bit });
        forces.push({ address, state: a & (1 << bit) ? "on" : "off" });
      }
      continue;
    }
    const word = parseInt(row[3]!, 8);
    for (let bit = 0; bit < 16; bit++) {
      const address = formatClassicAddress({ file: io, type: io, element: word, bit });
      if (a & (1 << bit)) forces.push({ address, state: "on" });
      if (b & (1 << bit)) forces.push({ address, state: "off" });
    }
  }
  return { forces, end: i };
}

/** Read the TITLE / RUNG DESCRIPTION block that follows a rung. */
function parseRungComment(lines: string[], start: number): { title?: string; comment?: string; end: number } {
  let i = start + 1;
  let mode: "none" | "title" | "desc" = "none";
  const title: string[] = [];
  const desc: string[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^%\s*Rung:/i.test(line) || /^SOR\b/.test(line) || isSectionStart(line)) break;
    if (/^%\s*TITLE\/RUNG DESCRIPTION/i.test(line)) continue;
    // "TITLE:" / "RUNG DESCRIPTION:" may carry text on the same line (SLC exports do).
    const t = line.match(/^TITLE:(.*)$/i);
    if (t) {
      mode = "title";
      if (t[1]!.trim()) title.push(t[1]!.trim());
      continue;
    }
    const d = line.match(/^RUNG DESCRIPTION:(.*)$/i);
    if (d) {
      mode = "desc";
      if (d[1]!.trim()) desc.push(d[1]!.trimEnd());
      continue;
    }
    if (/^\s*%\s*$/.test(line)) {
      // End of this comment block (another block may follow).
      mode = "none";
      continue;
    }
    if (mode === "title") title.push(line.trim());
    else if (mode === "desc") desc.push(line.replace(/\s+$/, ""));
  }
  const t = title.filter(Boolean).join("\n").trim();
  const d = desc.join("\n").replace(/^\n+|\n+$/g, "");
  const out: { title?: string; comment?: string; end: number } = { end: i };
  if (t) out.title = t;
  if (d.trim()) out.comment = d;
  return out;
}

function parseLadderSection(
  lines: string[],
  start: number,
): { rungs: Rung[]; end: number } {
  const rungs: Rung[] = [];
  let i = start + 1;
  let nextIndex = 0;
  let last: Rung | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (isSectionStart(line)) break;
    const meta = line.match(/^%\s*Rung:\s*(\d+)\s*%/i);
    if (meta) {
      nextIndex = Number(meta[1]);
      continue;
    }
    if (/^SOR\b/.test(line)) {
      const text = line.replace(/^\s*SOR\s+/, "").replace(/\s*EOR\s*$/, "").trim();
      last = { index: nextIndex, text, ladder: parseClassicLadder(text).root };
      rungs.push(last);
      nextIndex += 1;
      continue;
    }
    if (/^%\s*TITLE\/RUNG DESCRIPTION/i.test(line) && last) {
      const c = parseRungComment(lines, i);
      if (c.title) last.title = last.title ? `${last.title}\n${c.title}` : c.title;
      if (c.comment) last.comment = last.comment ? `${last.comment}\n\n${c.comment}` : c.comment;
      i = c.end - 1;
    }
  }
  return { rungs, end: i };
}

/** "% … %" comment text on a header line. */
const pctComment = (line: string) => line.match(/%\s*([^%]*?)\s*%/)?.[1];

export function parsePc5Text(text: string, fileName = "project.pc5", flavor: Flavor = "plc5"): ProjectModel {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const first = lines[0] ?? "";
  let header: { processorType?: string; series?: string; revision?: string; description?: string } = {};
  if (/^START\b/i.test(first)) {
    if (flavor === "slc") {
      const m = first.match(/^START\s+(\S+)/);
      header = { ...(m ? { processorType: m[1] } : {}) };
      const desc = pctComment(first)?.replace(m?.[1] ?? "", "").trim();
      if (desc) header.description = desc;
    } else header = parseHeader(first);
  }
  let name = fileName.replace(/\.[^.]+$/, "");
  const programNames = new Map<number, string>();
  const ladders: { number: number; rungs: Rung[] }[] = [];
  const dataFiles: DataFile[] = [];
  const forces: ForceEntry[] = [];
  const modules: ModuleNode[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // SLC rack / slot configuration
    const rack = line.match(/^RACK\s+(\d+)\s+(\S+)/);
    if (rack) {
      modules.push({ name: `Rack ${rack[1]}`, catalogNumber: rack[2]!, description: pctComment(line) ?? "", children: [] });
      continue;
    }
    const slot = line.match(/^SLOT\s+(\d+)\s+(\S+)/);
    if (slot) {
      const node: ModuleNode = { name: `Slot ${slot[1]}`, catalogNumber: slot[2]!, slot: slot[1]!, children: [], parent: "Rack 1" };
      const d = pctComment(line);
      if (d) node.description = d;
      (modules[0]?.children ?? modules).push(node);
      continue;
    }
    if (/^DATA\s+/.test(line)) {
      const { file, end } = parseDataSection(lines, i, flavor);
      dataFiles.push(file);
      i = end - 1;
      continue;
    }
    if (/^PROJECT\s+"/.test(line)) {
      name = line.match(/^PROJECT\s+"([^"]+)"/)?.[1]?.trim() ?? name;
      for (i += 1; i < lines.length && !isSectionStart(lines[i]!); i++) {
        const pm = lines[i]!.match(/^\s*(\d+)\s+"([^"]*)"\s*$/);
        if (pm) programNames.set(Number(pm[1]), pm[2]!.trim());
      }
      i -= 1;
      continue;
    }
    const lad = line.match(/^LADDER\s+(\d+)/);
    if (lad) {
      const { rungs, end } = parseLadderSection(lines, i);
      ladders.push({ number: Number(lad[1]), rungs });
      i = end - 1;
      continue;
    }
    if (/^FORCE\s+/.test(line)) {
      const { forces: f, end } = parseForceSection(lines, i, flavor);
      forces.push(...f);
      i = end - 1;
      continue;
    }
  }

  const programs: Program[] = ladders.map(({ number, rungs }) => {
    const progName = programNames.get(number) || `FILE ${number}`;
    return {
      name: progName,
      number,
      routines: [{ name: progName, number, type: "ladder", rungs }],
    };
  });

  const kind = flavor === "slc" ? "SLC" : "PC5";
  if (programs.length === 0) warnings.push(`No LADDER sections found in the ${kind} file.`);
  if (dataFiles.length === 0) warnings.push(`No DATA tables in the ${kind} file — saved values unavailable.`);

  const project = emptyProject(name, flavor, { name, ...header });
  project.programs = programs;
  project.dataFiles = dataFiles;
  project.forces = forces;
  project.modules = modules;
  project.warnings = warnings;
  return project;
}
