import { useMemo } from "react";
import type { LadderNode, RoutineRef } from "@core/model/types";
import type { AoiInstance, ProjectIndex } from "@core/query/index";
import { formatValue } from "@core/query/index";
import type { NodeState } from "@core/logic/evaluate";
import { instructionInfo } from "@core/logic/instructions";
import { isConstant, isTagOperand } from "@core/logic/refs";
import { layoutRung, type PlacedInstruction } from "../lib/ladderLayout";
import type { RoutineScope } from "../lib/nav";
import { evaluate } from "../lib/power";
import type { LadderPrefs } from "../lib/prefs";

const BIT_KINDS = new Set(["XIC", "XIO", "OTE", "OTL", "OTU", "ONS"]);
const COILS = new Set(["OTE", "OTL", "OTU"]);
const CHAR = 6.9;

type Instruction = Extract<LadderNode, { kind: "instruction" }>;

interface BoxRow {
  label: string;
  text: string;
  ref?: string;
  value?: string;
}

interface Drawn {
  bit: boolean;
  label?: string;
  description?: string;
  /** Saved state of a bit instruction: true = passes power / coil ON. */
  on?: boolean;
  title?: string;
  rows?: BoxRow[];
  tooltip?: string;
  jsr?: RoutineRef;
  /** AOI call: open its logic through this instance. */
  aoiLogic?: { ref: RoutineRef; instance: AoiInstance };
  forced?: boolean;
  w: number;
  h: number;
}

interface Metrics {
  lineY: number;
  rowH: number;
  boxRow: number;
  boxHead: number;
}

function metricsFor(prefs: LadderPrefs): Metrics {
  const lineY = prefs.descriptions ? 60 : 40;
  return {
    lineY,
    rowH: lineY + (prefs.compact ? 12 : 20),
    boxRow: prefs.compact ? 15 : 17,
    boxHead: prefs.compact ? 20 : 22,
  };
}

function bitGlyph(m: string): string {
  switch (m) {
    case "XIC":
      return "] [";
    case "XIO":
      return "]/[";
    case "OTE":
      return "( )";
    case "OTL":
      return "(L)";
    case "OTU":
      return "(U)";
    default:
      return `[${m}]`;
  }
}

/** Outputs (coils, blocks, AOI calls) get pushed to the right rail. */
function isOutputNode(node: LadderNode): boolean {
  if (node.kind === "instruction") {
    const info = instructionInfo(node.mnemonic);
    return info ? info.output === true : true; // AOIs and unknown instructions act as outputs
  }
  if (node.kind === "parallel") return node.branches.every(isOutputNode);
  return node.elements.length > 0 && node.elements.every(isOutputNode);
}

function drawBit(node: Instruction, index: ProjectIndex, where: RoutineScope, prefs: LadderPrefs, mt: Metrics): Drawn {
  const m = node.mnemonic.toUpperCase();
  const ref = node.operands[0] ?? "";
  const info = ref ? index.resolve(ref, where) : undefined;
  const desc = prefs.descriptions ? info?.description?.replace(/\s*\n\s*/g, " ").trim() : undefined;
  const label = prefs.symbols && info?.symbol && info.symbol !== ref ? info.symbol : ref;
  let on: boolean | undefined;
  if (prefs.values && info?.hasValue && typeof info.value === "boolean") {
    on = m === "XIO" ? !info.value : info.value;
  }
  const refChars = label.length <= 24 ? label.length : Math.ceil(label.length / 2) + 2;
  const textW = Math.max(refChars, Math.min(desc?.length ?? 0, 60) / 2) * CHAR;
  const d: Drawn = {
    bit: true,
    label,
    w: Math.max(prefs.compact ? 84 : 96, Math.min(prefs.compact ? 190 : 220, textW + 22)),
    h: mt.rowH,
    tooltip: [m, ref, label !== ref ? label : "", info?.description, info?.hasValue ? `Saved value: ${formatValue(info.value)}` : ""]
      .filter(Boolean)
      .join("\n"),
  };
  if (desc) d.description = desc;
  if (on !== undefined) d.on = on;
  if (info?.forced) d.forced = true;
  return d;
}

function drawBox(node: Instruction, index: ProjectIndex, where: RoutineScope, prefs: LadderPrefs, mt: Metrics): Drawn {
  const m = node.mnemonic.toUpperCase();
  const info = instructionInfo(m);
  const aoi = info ? undefined : index.aoi(node.mnemonic);
  let names: string[] = info?.operands ?? [];
  // Logix timers have no time base operand: TON(Timer, Preset, Accum).
  if (index.isLogix && info?.category === "timer" && m !== "RES") names = ["Timer", "Preset", "Accum"];
  if (aoi) {
    const required = aoi.parameters.filter((p) => p.required || p.usage?.toLowerCase() === "inout");
    names = [aoi.name, ...required.map((p) => p.name)];
  }
  const valueOf = (ref: string): string | undefined => {
    if (isConstant(ref)) return undefined;
    const r = index.resolve(ref, where);
    if (!r.hasValue || typeof r.value === "object") return undefined;
    return formatValue(r.value);
  };

  const rows: BoxRow[] = node.operands.map((op, i) => {
    const label = names[i] ?? `Operand ${i + 1}`;
    let text = op;
    let value: string | undefined;
    if (info && (info.category === "timer" || info.category === "counter") && i > 0 && node.operands[0]) {
      // The data table holds the preset/accum (Logix rung text just shows "?").
      const member = /preset/i.test(label) ? "PRE" : /accum/i.test(label) ? "ACC" : undefined;
      const saved = member ? valueOf(`${node.operands[0]}.${member}`) : undefined;
      if (saved !== undefined && (prefs.values || op === "?")) text = saved;
    } else if (prefs.values && isTagOperand(op, index.isLogix ? "logix" : "classic")) {
      value = valueOf(op);
    }
    const row: BoxRow = { label, text };
    if (!isConstant(op)) row.ref = op;
    if (value !== undefined && value !== text) row.value = value;
    return row;
  });

  const title = aoi ? aoi.name : m;
  const longest = Math.max(
    title.length + 4,
    ...rows.map((r) => r.label.length + r.text.length + (r.value ? r.value.length + 3 : 0) + 2),
  );
  const boxH = mt.boxHead + rows.length * mt.boxRow + 4;
  const d: Drawn = {
    bit: false,
    title,
    rows,
    w: Math.max(150, Math.min(340, longest * CHAR + 30)),
    h: mt.lineY - 12 + boxH + (prefs.compact ? 8 : 14),
  };
  if (m === "JSR") {
    const target = index.jsrTarget(node.operands, where);
    if (target) d.jsr = target;
  }
  if (aoi && !aoi.encoded && aoi.routines.length && node.operands[0]) {
    const logic = aoi.routines.find((r) => r.name.toUpperCase() === "LOGIC") ?? aoi.routines[0]!;
    d.aoiLogic = {
      ref: { kind: "aoi", owner: aoi.name, routine: logic.name },
      instance: {
        tag: node.operands[0],
        caller: where.instance
          ? { kind: where.kind, owner: where.owner, instance: where.instance }
          : { kind: where.kind, owner: where.owner },
      },
    };
  }
  if (aoi?.description) d.tooltip = aoi.description;
  if (node.operands.some((op) => !isConstant(op) && index.resolve(op, where).forced)) d.forced = true;
  return d;
}

export function LadderDiagram({
  root,
  index,
  where,
  prefs,
  minWidth,
  highlightKey,
  onSelectRef,
  onJump,
}: {
  root: LadderNode;
  index: ProjectIndex;
  where: RoutineScope;
  prefs: LadderPrefs;
  minWidth: number;
  highlightKey?: string;
  onSelectRef: (ref: string) => void;
  onJump: (target: RoutineRef, instance?: AoiInstance) => void;
}) {
  const { geo, drawn, mt, states } = useMemo(() => {
    const metrics = metricsFor(prefs);
    const ev = prefs.values ? evaluate(root, index, where) : undefined;
    const cache = new Map<Instruction, Drawn>();
    const draw = (n: Instruction): Drawn => {
      let d = cache.get(n);
      if (!d) {
        d = BIT_KINDS.has(n.mnemonic.toUpperCase())
          ? drawBit(n, index, where, prefs, metrics)
          : drawBox(n, index, where, prefs, metrics);
        cache.set(n, d);
      }
      return d;
    };
    const g = layoutRung(root, {
      lineY: metrics.lineY,
      rowH: metrics.rowH,
      branchGap: prefs.compact ? 0 : 4,
      branchPad: 10,
      railPad: 8,
      minWidth,
      measure: draw,
      isOutput: isOutputNode,
      ...(ev ? { power: (n: LadderNode) => ev.states.get(n) } : {}),
    });
    return { geo: g, drawn: cache, mt: metrics, states: ev?.states };
  }, [root, index, where, prefs, minWidth]);

  const line = (p: PlacedInstruction, top: number) => (
    <>
      <span className={`ld-line half left ${p.inOn ? "on" : ""}`} style={{ top }} />
      <span className={`ld-line half right ${p.outOn ? "on" : ""}`} style={{ top }} />
    </>
  );

  const highlighted = (ref: string | undefined) =>
    !!ref && !!highlightKey && index.resolve(ref, where).key === highlightKey;

  const renderInstr = (p: PlacedInstruction, i: number) => {
    const d = drawn.get(p.node)!;
    const node = p.node;
    const m = node.mnemonic.toUpperCase();
    if (d.bit) {
      const ref = node.operands[0];
      const state = d.on === true ? "on" : d.on === false ? "off" : "";
      return (
        <button
          key={i}
          type="button"
          className={`ld-bit ${COILS.has(m) ? "coil" : "contact"} ${highlighted(ref) ? "hl" : ""} ${state} ${d.forced ? "forced" : ""}`}
          style={{ left: p.x, top: p.y, width: p.w, height: mt.rowH }}
          title={d.tooltip}
          onClick={(e) => {
            e.stopPropagation();
            if (ref) onSelectRef(ref);
          }}
        >
          <span className="ld-label" style={{ height: mt.lineY - 12 }}>
            {d.description ? <span className="ld-desc">{d.description}</span> : null}
            <span className="ld-addr">{d.label}</span>
          </span>
          {line(p, mt.lineY)}
          <span className="ld-glyph" style={{ top: mt.lineY - 10 }}>
            {bitGlyph(m)}
          </span>
          {d.forced ? <span className="ld-force" title="Forced">F</span> : null}
        </button>
      );
    }
    const st: NodeState | undefined = states?.get(node);
    const isCompare = instructionInfo(m)?.category === "compare";
    const boxState = isCompare
      ? st?.cond === true
        ? "true"
        : st?.cond === false
          ? "false"
          : ""
      : st?.in === true
        ? "energized"
        : "";
    const opens = d.jsr ?? d.aoiLogic;
    return (
      <div key={i} className="ld-boxcell" style={{ left: p.x, top: p.y, width: p.w, height: p.h }}>
        {line(p, mt.lineY)}
        <div
          className={`ld-box ${opens ? "jsr" : ""} ${boxState} ${d.forced ? "forced" : ""}`}
          style={{ left: 8, top: mt.lineY - 12, width: p.w - 16 }}
          title={d.tooltip}
        >
          <button
            type="button"
            className="ld-box-title"
            style={{ height: mt.boxHead }}
            onClick={(e) => {
              e.stopPropagation();
              if (d.jsr) onJump(d.jsr);
              else if (d.aoiLogic) onJump(d.aoiLogic.ref, d.aoiLogic.instance);
              else if (node.operands[0] && !isConstant(node.operands[0])) onSelectRef(node.operands[0]);
            }}
            title={d.aoiLogic ? `Open ${d.title}'s logic with ${node.operands[0]}'s values` : undefined}
          >
            <span>{d.title}</span>
            {d.jsr ? <span className="ld-box-go">Open →</span> : d.aoiLogic ? <span className="ld-box-go">Logic →</span> : null}
          </button>
          {d.rows?.map((r, k) => (
            <button
              key={k}
              type="button"
              className={`ld-box-row ${highlighted(r.ref) ? "hl" : ""}`}
              style={{ height: mt.boxRow }}
              disabled={!r.ref}
              onClick={(e) => {
                e.stopPropagation();
                if (r.ref) onSelectRef(r.ref);
              }}
            >
              <span className="lbl">{r.label}</span>
              <span className="txt">{r.text}</span>
              {r.value !== undefined ? <span className="val">{r.value}</span> : null}
            </button>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="ld-scroll">
      <div className="ld-canvas" style={{ width: geo.width + 3, height: geo.height }}>
        <div className="ld-power" style={{ left: geo.leftRail, height: geo.height }} />
        <div className="ld-power" style={{ left: geo.rightRail, height: geo.height }} />
        {geo.wires.map((w, i) =>
          w.x2 > w.x1 ? (
            <div key={`w${i}`} className={`ld-wire ${w.on ? "on" : ""}`} style={{ left: w.x1, top: w.y, width: w.x2 - w.x1 }} />
          ) : null,
        )}
        {geo.rails.map((r, i) => (
          <div
            key={`r${i}`}
            className={`ld-vrail ${r.on ? "on" : ""}`}
            style={{ left: r.x, top: r.y1, height: r.y2 - r.y1 + 1.5 }}
          />
        ))}
        {geo.instrs.map(renderInstr)}
      </div>
    </div>
  );
}
