/**
 * Studio 5000 / RSLogix 5000 XML export (.L5X).
 *
 * Uses the same model and value decoder as the L5K importer: L5X tags carry
 * their values in <Data Format="L5K"> (the same literal syntax as L5K), with
 * <Data Format="Decorated"> as a fallback.
 */

import { emptyProject } from "../model/factory.js";
import type {
  AoiDefinition,
  DataTypeDef,
  DataTypeMember,
  ModuleNode,
  Program,
  ProjectModel,
  Routine,
  Rung,
  SavedValue,
  TagRecord,
  TaskInfo,
} from "../model/types.js";
import { parseNeutralLadder } from "../ladder/parse.js";
import { decodeValue, parseValueLiteral, type DecodeStats, type TypeRegistry } from "./l5kValues.js";
import { child, childrenOf, descriptionOf, parseXml, type XmlNode } from "./xml.js";
import { pickComm } from "./l5k.js";

const yes = (v?: string) => v !== undefined && /^(true|yes|1)$/i.test(v);

function parseDims(attr?: string): number[] | undefined {
  if (!attr) return undefined;
  const d = attr
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  return d.length ? d : undefined;
}

/* ------------------------------ decorated data ------------------------------ */

function scalar(value: string | undefined, dataType?: string): SavedValue | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  if ((dataType ?? "").toUpperCase() === "BOOL") return v === "1" || /^true$/i.test(v);
  const radix = v.match(/^(-?)(\d+)#([0-9A-Fa-f_]+)$/);
  if (radix) {
    const n = parseInt(radix[3]!.replace(/_/g, ""), Number(radix[2]));
    return radix[1] ? -n : n;
  }
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

function decorated(node: XmlNode): SavedValue | undefined {
  switch (node.name) {
    case "DataValue":
    case "DataValueMember": {
      if (node.attrs.Value !== undefined) return scalar(node.attrs.Value, node.attrs.DataType);
      const t = node.text.trim();
      return t ? t.replace(/^'|'$/g, "").replace(/\$00/g, "") : undefined;
    }
    case "Structure":
    case "StructureMember": {
      const obj: Record<string, SavedValue> = {};
      for (const c of node.children) {
        const name = c.attrs.Name;
        if (!name) continue;
        const v = decorated(c);
        if (v !== undefined) obj[name] = v;
      }
      // STRING-family structures read better as plain text.
      if (typeof obj.DATA === "string" && "LEN" in obj) return obj.DATA;
      return obj;
    }
    case "Array":
    case "ArrayMember":
      return childrenOf(node, "Element").map((el) => {
        if (el.attrs.Value !== undefined) return scalar(el.attrs.Value, node.attrs.DataType) ?? 0;
        const inner = el.children[0];
        return (inner ? decorated(inner) : undefined) ?? 0;
      });
    default:
      return undefined;
  }
}

/* ----------------------------------- tags ----------------------------------- */

interface PendingTag {
  tag: TagRecord;
  l5k?: string;
  decorated?: SavedValue;
}

function tagFrom(node: XmlNode, scope: string): PendingTag | null {
  const name = node.attrs.Name;
  if (!name) return null;
  const tag: TagRecord = { name, scope, dataType: node.attrs.DataType ?? (node.attrs.AliasFor ? "ALIAS" : "?") };
  const dims = parseDims(node.attrs.Dimensions ?? node.attrs.Dimension);
  if (dims) tag.dims = dims;
  if (node.attrs.AliasFor) tag.aliasFor = node.attrs.AliasFor;
  const desc = descriptionOf(node);
  if (desc) tag.description = desc;
  if (node.attrs.Usage) tag.usage = node.attrs.Usage;
  if (node.attrs.Required !== undefined) tag.required = yes(node.attrs.Required);
  if (node.attrs.Visible !== undefined) tag.visible = yes(node.attrs.Visible);
  for (const c of childrenOf(child(node, "Comments"), "Comment")) {
    const operand = (c.attrs.Operand ?? "").replace(/^\./, "").toUpperCase();
    const text = (c.text || child(c, "LocalizedComment")?.text || "").trim();
    if (operand && text) (tag.memberDescriptions ??= {})[operand] = text;
  }
  const msg = childrenOf(node, "Data").map((d) => child(d, "MessageParameters")).find(Boolean);
  const comm = pickComm({
    ...(node.attrs.TagType === "Consumed" ? { TagType: "Consumed" } : {}),
    ...(child(node, "ConsumeInfo")?.attrs ?? {}),
    ...(child(node, "ProduceInfo")?.attrs ?? {}),
    ...(msg?.attrs ?? {}),
  });
  if (comm) tag.comm = comm;
  const pending: PendingTag = { tag };
  for (const d of childrenOf(node, "Data")) {
    const fmt = (d.attrs.Format ?? "").toUpperCase();
    if (fmt === "L5K" && d.text.trim()) pending.l5k = d.text.trim();
    else if (fmt === "DECORATED" && d.children[0]) {
      const v = decorated(d.children[0]);
      if (v !== undefined) pending.decorated = v;
    } else if (fmt === "STRING" && d.text.trim()) {
      pending.decorated = d.text.trim().replace(/^'|'$/g, "");
    }
  }
  return pending;
}

/* --------------------------------- routines --------------------------------- */

function routineType(t?: string): Routine["type"] {
  switch ((t ?? "RLL").toUpperCase()) {
    case "ST":
      return "st";
    case "FBD":
      return "fbd";
    case "SFC":
      return "sfc";
    default:
      return "ladder";
  }
}

function routineFrom(node: XmlNode): Routine {
  if (node.name === "EncodedData") {
    const r: Routine = { name: node.attrs.Name ?? "Encoded routine", type: routineType(node.attrs.Type), rungs: [], encoded: true };
    const d = descriptionOf(node);
    if (d) r.description = d;
    return r;
  }
  const routine: Routine = { name: node.attrs.Name ?? "?", type: routineType(node.attrs.Type), rungs: [] };
  const d = descriptionOf(node);
  if (d) routine.description = d;
  if (routine.type === "ladder") {
    const rungs: Rung[] = [];
    let index = 0;
    for (const r of childrenOf(child(node, "RLLContent"), "Rung")) {
      // I / R / D rungs are pending online edits; show the accepted logic.
      const type = (r.attrs.Type ?? "N").toUpperCase();
      if (type !== "N") continue;
      const text = (child(r, "Text")?.text ?? "").replace(/\s*\n\s*/g, " ").trim().replace(/;\s*$/, "");
      const number = r.attrs.Number !== undefined ? Number(r.attrs.Number) : index;
      const rung: Rung = { index: number, text, ladder: parseNeutralLadder(text).root };
      const comment = (child(r, "Comment")?.text || child(child(r, "Comment"), "LocalizedComment")?.text || "").trim();
      if (comment) rung.comment = comment;
      rungs.push(rung);
      index = number + 1;
    }
    routine.rungs = rungs;
  } else if (routine.type === "st") {
    routine.stLines = childrenOf(child(node, "STContent"), "Line").map((l) => l.text.replace(/\s+$/, ""));
  }
  return routine;
}

function routinesOf(node: XmlNode | undefined): Routine[] {
  return (node?.children ?? []).filter((c) => c.name === "Routine" || c.name === "EncodedData").map(routineFrom);
}

/* ---------------------------------- parser ---------------------------------- */

export function parseL5xText(text: string, fileName = "project.l5x"): ProjectModel {
  const doc = parseXml(text.replace(/^﻿/, ""));
  const content = child(doc, "RSLogix5000Content");
  const ctrl = child(content, "Controller");
  const warnings: string[] = [];
  if (!content || !ctrl) {
    throw new Error("This doesn't look like a Studio 5000 L5X export (no RSLogix5000Content/Controller element).");
  }
  if (content.attrs.TargetType && content.attrs.TargetType !== "Controller") {
    warnings.push(
      `This L5X is a partial export (${content.attrs.TargetType} "${content.attrs.TargetName ?? ""}"), not the whole controller — tags and logic outside it aren't included.`,
    );
  }

  const name = ctrl.attrs.Name ?? content.attrs.TargetName ?? fileName.replace(/\.[^.]+$/, "");

  // Data types
  const dataTypes: DataTypeDef[] = childrenOf(child(ctrl, "DataTypes"), "DataType").map((dt) => {
    const def: DataTypeDef = { name: dt.attrs.Name ?? "?", members: [] };
    const d = descriptionOf(dt);
    if (d) def.description = d;
    if (dt.attrs.Family) def.family = dt.attrs.Family;
    for (const m of childrenOf(child(dt, "Members"), "Member")) {
      const member: DataTypeMember = { name: m.attrs.Name ?? "?", dataType: m.attrs.DataType ?? "?" };
      if (member.dataType.toUpperCase() === "BIT" && m.attrs.Target) {
        member.dataType = "BOOL";
        member.bitOf = { host: m.attrs.Target, bit: Number(m.attrs.BitNumber ?? 0) };
      }
      const dim = Number(m.attrs.Dimension ?? 0);
      if (dim > 0) member.dims = dim;
      if (yes(m.attrs.Hidden)) member.hidden = true;
      const md = descriptionOf(m);
      if (md) member.description = md;
      def.members.push(member);
    }
    return def;
  });

  // Add-On Instructions (plain and source-protected)
  const aois: AoiDefinition[] = [];
  for (const a of child(ctrl, "AddOnInstructionDefinitions")?.children ?? []) {
    const encoded = a.name === "EncodedData";
    if (a.name !== "AddOnInstructionDefinition" && !encoded) continue;
    const aoiName = a.attrs.Name ?? "?";
    const aoi: AoiDefinition = { name: aoiName, parameters: [], localTags: [], routines: [] };
    const d = descriptionOf(a);
    if (d) aoi.description = d;
    if (a.attrs.Revision) aoi.revision = a.attrs.Revision;
    if (a.attrs.Vendor) aoi.vendor = a.attrs.Vendor;
    const help = descriptionOf(a, "AdditionalHelpText");
    if (help) aoi.helpText = help;
    if (encoded) aoi.encoded = true;
    for (const p of childrenOf(child(a, "Parameters"), "Parameter")) {
      const t = tagFrom(p, `AOI:${aoiName}`);
      if (t) aoi.parameters.push(t.tag);
    }
    for (const l of childrenOf(child(a, "LocalTags"), "LocalTag")) {
      const t = tagFrom(l, `AOI:${aoiName}`);
      if (t) aoi.localTags.push(t.tag);
    }
    if (!encoded) aoi.routines = routinesOf(child(a, "Routines"));
    aois.push(aoi);
  }

  // Modules
  const flatModules: ModuleNode[] = childrenOf(child(ctrl, "Modules"), "Module").map((m) => {
    const node: ModuleNode = { name: m.attrs.Name ?? "?", children: [], raw: m.attrs };
    if (m.attrs.CatalogNumber) node.catalogNumber = m.attrs.CatalogNumber;
    const d = descriptionOf(m);
    if (d) node.description = d;
    if (m.attrs.ParentModule) node.parent = m.attrs.ParentModule;
    if (m.attrs.Major) node.revision = m.attrs.Minor ? `${m.attrs.Major}.${m.attrs.Minor}` : m.attrs.Major;
    if (yes(m.attrs.Inhibited)) node.inhibited = true;
    for (const port of childrenOf(child(m, "Ports"), "Port")) {
      const addr = port.attrs.Address ?? "";
      if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) node.address = addr;
      else if (yes(port.attrs.Upstream) && /^\d+$/.test(addr)) node.slot = addr;
    }
    return node;
  });
  const byName = new Map(flatModules.map((m) => [m.name, m]));
  const modules: ModuleNode[] = [];
  for (const m of flatModules) {
    const parent = m.parent && m.parent !== m.name ? byName.get(m.parent) : undefined;
    if (parent) parent.children.push(m);
    else modules.push(m);
  }

  // Tags and programs
  const pending: PendingTag[] = [];
  for (const t of childrenOf(child(ctrl, "Tags"), "Tag")) {
    const p = tagFrom(t, "");
    if (p) pending.push(p);
  }
  const programs: Program[] = childrenOf(child(ctrl, "Programs"), "Program").map((p) => {
    const program: Program = { name: p.attrs.Name ?? "?", routines: routinesOf(child(p, "Routines")) };
    const d = descriptionOf(p);
    if (d) program.description = d;
    if (p.attrs.MainRoutineName) program.mainRoutine = p.attrs.MainRoutineName;
    if (p.attrs.FaultRoutineName) program.faultRoutine = p.attrs.FaultRoutineName;
    if (yes(p.attrs.Disabled)) program.disabled = true;
    for (const t of childrenOf(child(p, "Tags"), "Tag")) {
      const pt = tagFrom(t, program.name);
      if (pt) pending.push(pt);
    }
    return program;
  });

  // Tasks
  const tasks: TaskInfo[] = childrenOf(child(ctrl, "Tasks"), "Task").map((t) => {
    const task: TaskInfo = {
      name: t.attrs.Name ?? "?",
      programs: childrenOf(child(t, "ScheduledPrograms"), "ScheduledProgram").map((s) => s.attrs.Name ?? "?"),
    };
    const d = descriptionOf(t);
    if (d) task.description = d;
    if (t.attrs.Type) task.type = t.attrs.Type;
    if (t.attrs.Rate) task.rate = t.attrs.Rate;
    if (t.attrs.Priority) task.priority = t.attrs.Priority;
    if (t.attrs.Watchdog) task.watchdog = t.attrs.Watchdog;
    if (yes(t.attrs.InhibitTask)) task.inhibited = true;
    return task;
  });

  // Decode saved values now that every UDT / AOI layout is known.
  const reg: TypeRegistry = {
    dataTypes: new Map(dataTypes.map((d) => [d.name.toUpperCase(), d])),
    aois: new Map(aois.map((a) => [a.name.toUpperCase(), a])),
  };
  const stats: DecodeStats = { decoded: 0, mismatched: 0, unknownTypes: new Set() };
  const tags: TagRecord[] = pending.map((p) => {
    if (p.l5k) {
      const raw = parseValueLiteral(p.l5k);
      const v = raw !== undefined ? decodeValue(p.tag.dataType, p.tag.dims, raw, reg, stats) : undefined;
      if (v !== undefined) p.tag.value = v;
    }
    if (p.tag.value === undefined && p.decorated !== undefined) p.tag.value = p.decorated;
    return p.tag;
  });
  if (stats.mismatched > 0) {
    warnings.push(`${stats.mismatched} saved structure value(s) didn't match their type layout exactly; some member values may be off.`);
  }
  if (programs.length === 0) warnings.push("No programs in this L5X.");

  const project = emptyProject(name, "logix", {
    name,
    processorType: ctrl.attrs.ProcessorType,
    description: descriptionOf(ctrl)?.split("\n")[0],
    majorRevision: ctrl.attrs.MajorRev ? Number(ctrl.attrs.MajorRev) : undefined,
    serialNumber: ctrl.attrs.ProjectSN,
    raw: ctrl.attrs,
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
