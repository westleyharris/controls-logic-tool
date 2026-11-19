import { emptyProject } from "../model/factory.js";
import type {
  AoiDefinition,
  DataTypeDef,
  DataTypeMember,
  ModuleNode,
  Program,
  ProjectModel,
  Routine,
  RoutineType,
  Rung,
  TagRecord,
  TaskInfo,
} from "../model/types.js";
import { parseNeutralLadder } from "../ladder/parse.js";
import { decodeValue, parseValueLiteral, type DecodeStats, type TypeRegistry } from "./l5kValues.js";

/* ------------------------------ lexical helpers ----------------------------- */

/** Unescape an L5K "…" string body ($N newline, $Q quote, $$ dollar, $xx hex). */
export function unescapeL5k(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "$") {
      out += ch;
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-9A-Fa-f]{2}/.test(body.slice(i + 1, i + 3))) {
      const code = parseInt(body.slice(i + 1, i + 3), 16);
      if (code) out += String.fromCharCode(code);
      i += 2;
      continue;
    }
    i += 1;
    switch (next.toUpperCase()) {
      case "N":
      case "L":
        out += "\n";
        break;
      case "T":
        out += "\t";
        break;
      case "Q":
        out += '"';
        break;
      case "R":
      case "P":
        break;
      default:
        out += next;
    }
  }
  return out;
}

/** Index just past the `)` matching the `(` at `open`, honoring quoted strings. */
function matchClose(text: string, open: number, openCh = "(", closeCh = ")"): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "$") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "$") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const tail = text.slice(start);
  if (tail.trim()) out.push(tail);
  return out;
}

/** Concatenate one or more "…" string pieces and unescape. */
function readStrings(text: string): string {
  const parts: string[] = [];
  for (const m of text.matchAll(/"((?:\$.|[^"$])*)"/g)) parts.push(m[1]!);
  return unescapeL5k(parts.join(""));
}

/** Parse `(Key := value, Other := "text", COMMENT.X := "…")` into a map. */
function parseAttrs(parenText: string): Record<string, string> {
  const inner = parenText.trim().replace(/^\(/, "").replace(/\)$/, "");
  const out: Record<string, string> = {};
  for (const part of splitTop(inner, ",")) {
    const m = part.match(/^\s*([A-Za-z_][\w.[\]]*)\s*:=\s*([\s\S]*)$/);
    if (!m) continue;
    const raw = m[2]!.trim();
    out[m[1]!] = raw.startsWith('"') ? readStrings(raw) : raw;
  }
  return out;
}

interface Block {
  name: string;
  attrs: Record<string, string>;
  /** Text after the header up to the END_ marker. */
  body: string;
}

/** Find `<indent>KEYWORD name (attrs)` … `<indent>END_KEYWORD` blocks. */
function findBlocks(text: string, indent: string, keyword: string, endKeyword = `END_${keyword}`): Block[] {
  const blocks: Block[] = [];
  const startRe = new RegExp(`^${indent}${keyword}\\b[ \\t]*([^\\s(;]*)`, "gm");
  const endRe = new RegExp(`^${indent}${endKeyword}\\b`, "gm");
  for (const m of text.matchAll(startRe)) {
    const start = m.index ?? 0;
    let cursor = start + m[0].length;
    let attrs: Record<string, string> = {};
    const lineEnd = text.indexOf("\n", cursor);
    const paren = text.indexOf("(", cursor);
    if (paren >= 0 && (lineEnd < 0 || paren < lineEnd)) {
      const close = matchClose(text, paren);
      attrs = parseAttrs(text.slice(paren, close));
      cursor = close;
    }
    endRe.lastIndex = cursor;
    const end = endRe.exec(text);
    const stop = end ? end.index : text.length;
    blocks.push({ name: m[1] ?? "", attrs, body: text.slice(cursor, stop) });
  }
  return blocks;
}

function firstLine(s: string | undefined): string | undefined {
  return s?.split("\n").map((l) => l.trim()).find(Boolean);
}

function parseDims(text: string | undefined): number[] | undefined {
  if (!text) return undefined;
  const dims = text.split(",").map((d) => Number(d.trim())).filter((n) => Number.isFinite(n) && n > 0);
  return dims.length ? dims : undefined;
}

/* -------------------------------- tags / UDTs ------------------------------- */

interface PendingTag {
  tag: TagRecord;
  valueText?: string;
}

/** Tag attributes that describe communication with other devices. */
const COMM_KEYS = [
  "MessageType",
  "ConnectionPath",
  "RemoteElement",
  "LocalElement",
  "DestinationTag",
  "ServiceCode",
  "ObjectType",
  "ProduceCount",
  "Producer",
  "RemoteTag",
  "RemoteFile",
  "TagType",
];

export function pickComm(attrs: Record<string, string | undefined>): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const k of COMM_KEYS) {
    const v = attrs[k];
    if (v !== undefined && v !== "") (out ??= {})[k] = v.replace(/^"|"$/g, "");
  }
  return out;
}

function parseTagStatement(stmt: string, scope: string): PendingTag | null {
  const s = stmt.trim();
  const m = s.match(
    /^([A-Za-z_]\w*)\s*(?::\s*([A-Za-z_][\w:]*)\s*(?:\[([\d,\s]+)\])?|\s+OF\s+([^\s(]+))/,
  );
  if (!m) return null;
  const tag: TagRecord = { name: m[1]!, scope, dataType: m[2] ?? "ALIAS" };
  const dims = parseDims(m[3]);
  if (dims) tag.dims = dims;
  if (m[4]) tag.aliasFor = m[4];

  let rest = s.slice(m[0].length).trimStart();
  if (rest.startsWith("(")) {
    const close = matchClose(rest, 0);
    const attrs = parseAttrs(rest.slice(0, close));
    rest = rest.slice(close).trimStart();
    if (attrs.Description) tag.description = attrs.Description;
    if (attrs.Usage) tag.usage = attrs.Usage;
    if (attrs.Required) tag.required = /^yes$/i.test(attrs.Required);
    if (attrs.Visible) tag.visible = /^yes$/i.test(attrs.Visible);
    const comm = pickComm(attrs);
    if (comm) tag.comm = comm;
    for (const [k, v] of Object.entries(attrs)) {
      if (k.toUpperCase().startsWith("COMMENT")) {
        const member = k.replace(/^COMMENT/i, "").replace(/^\./, "").toUpperCase();
        (tag.memberDescriptions ??= {})[member] = v;
      }
    }
  }
  const pending: PendingTag = { tag };
  if (rest.startsWith(":=")) pending.valueText = rest.slice(2).trim();
  return pending;
}

function parseTagBlockBody(body: string, scope: string): PendingTag[] {
  const out: PendingTag[] = [];
  for (const stmt of splitTop(body, ";")) {
    const p = parseTagStatement(stmt, scope);
    if (p) out.push(p);
  }
  return out;
}

function parseDataType(block: Block): DataTypeDef {
  const def: DataTypeDef = { name: block.name, members: [] };
  if (block.attrs.Description) def.description = block.attrs.Description;
  if (block.attrs.FamilyType) def.family = block.attrs.FamilyType;
  for (const stmt of splitTop(block.body, ";")) {
    const s = stmt.trim();
    let member: DataTypeMember | undefined;
    let rest = "";
    const bit = s.match(/^BIT\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*:\s*(\d+)/);
    if (bit) {
      member = { name: bit[1]!, dataType: "BOOL", bitOf: { host: bit[2]!, bit: Number(bit[3]) } };
      rest = s.slice(bit[0].length);
    } else {
      const m = s.match(/^([A-Za-z_][\w:]*)\s+([A-Za-z_]\w*)(?:\[(\d+)\])?/);
      if (!m) continue;
      member = { name: m[2]!, dataType: m[1]! };
      if (m[3]) member.dims = Number(m[3]);
      rest = s.slice(m[0].length);
    }
    const paren = rest.indexOf("(");
    if (paren >= 0) {
      const attrs = parseAttrs(rest.slice(paren, matchClose(rest, paren)));
      if (attrs.Description) member.description = attrs.Description;
      if (attrs.Hidden === "1") member.hidden = true;
    }
    def.members.push(member);
  }
  return def;
}

/* --------------------------------- routines --------------------------------- */

function routineType(raw: string | undefined, keyword: string): RoutineType {
  const k = keyword.toUpperCase();
  if (k.startsWith("ST_")) return "st";
  if (k.startsWith("FBD_")) return "fbd";
  if (k.startsWith("SFC_")) return "sfc";
  const t = (raw ?? "RLL").toUpperCase();
  if (t === "ST") return "st";
  if (t === "FBD") return "fbd";
  if (t === "SFC") return "sfc";
  return "ladder";
}

function parseLadderBody(body: string): Rung[] {
  const rungs: Rung[] = [];
  let pendingComment: string | undefined;
  let index = 0;
  for (const stmt of splitTop(body, ";")) {
    const s = stmt.trim();
    if (s.startsWith("RC:")) {
      pendingComment = readStrings(s.slice(3)).trim() || undefined;
      continue;
    }
    // Older / alternate syntax: RUNG 0 (N := "XIC(A)OTE(B);", Comment := "…")
    const alt = s.match(/^RUNG\s+(\d+)\s*\(/);
    if (alt) {
      const attrs = parseAttrs(s.slice(s.indexOf("(")));
      const text = (attrs.N ?? "").replace(/;\s*$/, "").trim();
      if (text) {
        const rung: Rung = { index: Number(alt[1]), text, ladder: parseNeutralLadder(text).root };
        const c = attrs.Comment ?? pendingComment;
        if (c) rung.comment = c;
        rungs.push(rung);
        index = rung.index + 1;
      }
      pendingComment = undefined;
      continue;
    }
    const n = s.match(/^([NIRD]):\s*([\s\S]*)$/);
    if (!n) continue;
    // I/R/D are pending online edits; show the accepted (N) logic only.
    if (n[1] !== "N") continue;
    const text = n[2]!.replace(/\s*\n\s*/g, " ").trim();
    const rung: Rung = { index, text, ladder: parseNeutralLadder(text).root };
    if (pendingComment) rung.comment = pendingComment;
    rungs.push(rung);
    pendingComment = undefined;
    index += 1;
  }
  return rungs;
}

function parseRoutines(scopeText: string): Routine[] {
  const routines: Routine[] = [];
  const kinds: [string, string][] = [
    ["ROUTINE", "END_ROUTINE"],
    ["ST_ROUTINE", "END_ST_ROUTINE"],
    ["FBD_ROUTINE", "END_FBD_ROUTINE"],
    ["SFC_ROUTINE", "END_SFC_ROUTINE"],
  ];
  const found: { pos: number; routine: Routine }[] = [];
  for (const [kw, end] of kinds) {
    for (const block of findBlocks(scopeText, "\\t\\t", kw, end)) {
      const type = routineType(block.attrs.Type, kw);
      const routine: Routine = { name: block.name, type, rungs: [] };
      if (block.attrs.Description) routine.description = block.attrs.Description;
      if (type === "ladder") routine.rungs = parseLadderBody(block.body);
      else if (type === "st") {
        routine.stLines = block.body
          .split("\n")
          .map((l) => l.replace(/^\s*'/, "").replace(/\s+$/, ""))
          .filter((l, i, arr) => !(i === 0 && !l) && !(i === arr.length - 1 && !l));
      }
      found.push({ pos: scopeText.indexOf(`${kw} ${block.name}`), routine });
    }
  }
  for (const block of findBlocks(scopeText, "\\t\\t", "ENCODED_DATA")) {
    if (!/ROUTINE/i.test(block.attrs.EncodedType ?? "")) continue;
    const routine: Routine = {
      name: block.attrs.Name ?? "Encoded routine",
      type: routineType(block.attrs.Type, "ROUTINE"),
      rungs: [],
      encoded: true,
    };
    if (block.attrs.Description) routine.description = block.attrs.Description;
    found.push({ pos: scopeText.indexOf(block.attrs.Name ?? "\u0000"), routine });
  }
  found.sort((a, b) => a.pos - b.pos);
  for (const f of found) routines.push(f.routine);
  return routines;
}

/* ----------------------------------- AOIs ----------------------------------- */

function parseAoi(block: Block, encoded: boolean): { aoi: AoiDefinition; pending: PendingTag[] } {
  const name = encoded ? (block.attrs.Name ?? block.name) : block.name;
  const aoi: AoiDefinition = { name, parameters: [], localTags: [], routines: [] };
  if (block.attrs.Description) aoi.description = block.attrs.Description;
  if (block.attrs.Revision) aoi.revision = block.attrs.Revision;
  if (block.attrs.Vendor) aoi.vendor = block.attrs.Vendor;
  if (block.attrs.AdditionalHelpText) aoi.helpText = block.attrs.AdditionalHelpText;
  if (encoded) aoi.encoded = true;

  const pending: PendingTag[] = [];
  for (const p of findBlocks(block.body, "\\t\\t", "PARAMETERS")) {
    for (const t of parseTagBlockBody(p.body, `AOI:${name}`)) aoi.parameters.push(t.tag);
  }
  for (const p of findBlocks(block.body, "\\t\\t", "LOCAL_TAGS")) {
    for (const t of parseTagBlockBody(p.body, `AOI:${name}`)) aoi.localTags.push(t.tag);
  }
  if (!encoded) aoi.routines = parseRoutines(block.body);
  return { aoi, pending };
}

/* ---------------------------------- parser ---------------------------------- */

/**
 * Studio 5000 / RSLogix 5000 .L5K ASCII export.
 * Indentation-structured: `\tKEYWORD` at controller scope, `\t\tKEYWORD` inside.
 */
export function parseL5kText(text: string, fileName = "project.l5k"): ProjectModel {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const warnings: string[] = [];

  // Controller header
  let name = fileName.replace(/\.[^.]+$/, "");
  let controllerAttrs: Record<string, string> = {};
  const ctrl = src.match(/^CONTROLLER\s+([^\s(]+)\s*\(/m);
  if (ctrl && ctrl.index !== undefined) {
    name = ctrl[1]!;
    const open = src.indexOf("(", ctrl.index);
    controllerAttrs = parseAttrs(src.slice(open, matchClose(src, open)));
  } else {
    warnings.push("CONTROLLER header not found; using the file name as the project name.");
  }

  // Data types
  const dataTypes = findBlocks(src, "\\t", "DATATYPE").map(parseDataType);

  // AOIs (plain + source-protected)
  const aois: AoiDefinition[] = [];
  for (const block of findBlocks(src, "\\t", "ADD_ON_INSTRUCTION_DEFINITION")) {
    aois.push(parseAoi(block, false).aoi);
  }
  for (const block of findBlocks(src, "\\t", "ENCODED_DATA")) {
    if (/ADD_ON_INSTRUCTION/i.test(block.attrs.EncodedType ?? "")) aois.push(parseAoi(block, true).aoi);
  }

  // Modules
  const flatModules: ModuleNode[] = findBlocks(src, "\\t", "MODULE").map((b) => {
    const a = b.attrs;
    const node: ModuleNode = { name: b.name, children: [], raw: a };
    if (a.CatalogNumber) node.catalogNumber = a.CatalogNumber;
    if (a.Description) node.description = a.Description;
    if (a.Parent) node.parent = a.Parent;
    if (a.Slot !== undefined) node.slot = a.Slot;
    if (a.NodeAddress) node.address = a.NodeAddress;
    if (a.Major) node.revision = a.Minor ? `${a.Major}.${a.Minor}` : a.Major;
    if (a.Inhibited && /yes|1/i.test(a.Inhibited)) node.inhibited = true;
    return node;
  });
  const byName = new Map(flatModules.map((m) => [m.name, m]));
  const modules: ModuleNode[] = [];
  for (const m of flatModules) {
    const parent = m.parent && m.parent !== m.name ? byName.get(m.parent) : undefined;
    if (parent) parent.children.push(m);
    else modules.push(m);
  }

  // Tags
  const pending: PendingTag[] = [];
  for (const block of findBlocks(src, "\\t", "TAG")) pending.push(...parseTagBlockBody(block.body, ""));

  // Programs
  const programs: Program[] = [];
  for (const block of findBlocks(src, "\\t", "PROGRAM")) {
    const a = block.attrs;
    const program: Program = { name: block.name, routines: parseRoutines(block.body) };
    if (a.Description) program.description = a.Description;
    const main = a.MAIN ?? a.MainRoutineName;
    if (main) program.mainRoutine = main.replace(/"/g, "");
    if (a.FAULT) program.faultRoutine = a.FAULT.replace(/"/g, "");
    if (a.DisableFlag === "1") program.disabled = true;
    for (const t of findBlocks(block.body, "\\t\\t", "TAG")) {
      pending.push(...parseTagBlockBody(t.body, block.name));
    }
    programs.push(program);
  }

  // Tasks
  const tasks: TaskInfo[] = findBlocks(src, "\\t", "TASK").map((b) => {
    const a = b.attrs;
    const task: TaskInfo = {
      name: b.name,
      programs: splitTop(b.body, ";")
        .map((s) => s.trim())
        .map((s) => s.replace(/^PROGRAM\s+/, ""))
        .filter((s) => /^[A-Za-z_]\w*$/.test(s)),
    };
    if (a.Description) task.description = a.Description;
    if (a.Type) task.type = a.Type;
    if (a.Rate) task.rate = a.Rate;
    if (a.Priority) task.priority = a.Priority;
    if (a.Watchdog) task.watchdog = a.Watchdog;
    if (a.InhibitTask && /yes/i.test(a.InhibitTask)) task.inhibited = true;
    return task;
  });

  // Decode saved values now that every UDT / AOI layout is known.
  const reg: TypeRegistry = {
    dataTypes: new Map(dataTypes.map((d) => [d.name.toUpperCase(), d])),
    aois: new Map(aois.map((a) => [a.name.toUpperCase(), a])),
  };
  const stats: DecodeStats = { decoded: 0, mismatched: 0, unknownTypes: new Set() };
  const tags: TagRecord[] = [];
  for (const p of pending) {
    if (p.valueText) {
      const raw = parseValueLiteral(p.valueText);
      if (raw !== undefined) {
        const v = decodeValue(p.tag.dataType, p.tag.dims, raw, reg, stats);
        if (v !== undefined) p.tag.value = v;
      }
    }
    tags.push(p.tag);
  }
  if (stats.mismatched > 0) {
    warnings.push(
      `${stats.mismatched} saved structure value(s) didn't match their type layout exactly; some member values may be off.`,
    );
  }

  if (programs.length === 0) warnings.push("No PROGRAM blocks found.");

  const project = emptyProject(name, "logix", {
    name,
    processorType: controllerAttrs.ProcessorType,
    description: firstLine(controllerAttrs.Description),
    majorRevision: controllerAttrs.Major ? Number(controllerAttrs.Major) : undefined,
    serialNumber: controllerAttrs.SerialNumber,
    raw: controllerAttrs,
  });
  project.programs = programs;
  project.tasks = tasks;
  project.modules = modules;
  project.aois = aois;
  project.dataTypes = dataTypes;
  project.tags = tags;
  project.warnings = warnings;
  return project;
}
