import type { LadderNode } from "@core/model/types";
import type { NodeState } from "@core/logic/evaluate";

/**
 * Ladder geometry, RSLogix-style: elements in series sit on one rung line,
 * parallel branches stack below each other only as tall as their own
 * content needs, and the rung's output instructions are pushed to the
 * right power rail.
 */

type Instruction = Extract<LadderNode, { kind: "instruction" }>;

export interface PlacedInstruction {
  node: Instruction;
  x: number;
  /** Top of the element's row; the rung line runs at y + lineY. */
  y: number;
  w: number;
  h: number;
  /** Energized on the left / right side (power flow). */
  inOn?: boolean;
  outOn?: boolean;
}

export interface Wire {
  x1: number;
  x2: number;
  y: number;
  on?: boolean;
}

export interface Rail {
  x: number;
  y1: number;
  y2: number;
  on?: boolean;
}

export interface LadderGeometry {
  instrs: PlacedInstruction[];
  wires: Wire[];
  rails: Rail[];
  width: number;
  height: number;
  /** x of the left and right power rails. */
  leftRail: number;
  rightRail: number;
}

export interface LayoutOptions {
  lineY: number;
  /** Minimum height of a row (a plain contact). */
  rowH: number;
  /** Vertical gap between stacked branches. */
  branchGap: number;
  /** Horizontal lead-in/out inside a branch. */
  branchPad: number;
  /** Space between a rail and the first/last element. */
  railPad: number;
  /** Width the drawing should fill (the visible pane). */
  minWidth: number;
  measure: (node: Instruction) => { w: number; h: number };
  isOutput: (node: LadderNode) => boolean;
  /** Power-flow state per node, when saved values are shown. */
  power?: (node: LadderNode) => NodeState | undefined;
}

interface Out {
  instrs: PlacedInstruction[];
  wires: Wire[];
  rails: Rail[];
}

function place(node: LadderNode, x: number, y: number, o: LayoutOptions, out: Out): { w: number; h: number } {
  if (node.kind === "instruction") {
    const m = o.measure(node);
    const st = o.power?.(node);
    out.instrs.push({ node, x, y, w: m.w, h: m.h, inOn: st?.in === true, outOn: st?.out === true });
    return m;
  }
  if (node.kind === "series") return placeSeries(node.elements, x, y, o, out, o.power?.(node)?.in === true);

  const rows: { y: number; w: number; outOn: boolean }[] = [];
  let cy = y;
  for (const branch of node.branches) {
    const b = place(branch, x + o.branchPad, cy, o, out);
    rows.push({ y: cy, w: b.w, outOn: o.power?.(branch)?.out === true });
    cy += b.h + o.branchGap;
  }
  const st = o.power?.(node);
  const inOn = st?.in === true;
  const inner = Math.max(...rows.map((r) => r.w));
  const w = inner + o.branchPad * 2;
  for (const r of rows) {
    out.wires.push({ x1: x, x2: x + o.branchPad, y: r.y + o.lineY, on: inOn });
    out.wires.push({ x1: x + o.branchPad + r.w, x2: x + w, y: r.y + o.lineY, on: r.outOn });
  }
  const first = rows[0]!.y + o.lineY;
  const last = rows[rows.length - 1]!.y + o.lineY;
  if (rows.length > 1) {
    out.rails.push({ x, y1: first, y2: last, on: inOn });
    out.rails.push({ x: x + w, y1: first, y2: last, on: st?.out === true });
  }
  return { w, h: cy - y - o.branchGap };
}

function placeSeries(elements: LadderNode[], x: number, y: number, o: LayoutOptions, out: Out, stubOn = false) {
  if (elements.length === 0) {
    out.wires.push({ x1: x, x2: x + 24, y: y + o.lineY, on: stubOn });
    return { w: 24, h: o.rowH };
  }
  let cx = x;
  let h = o.rowH;
  for (const el of elements) {
    const b = place(el, cx, y, o, out);
    cx += b.w;
    h = Math.max(h, b.h);
  }
  return { w: cx - x, h };
}

export function layoutRung(root: LadderNode, o: LayoutOptions): LadderGeometry {
  const elements = root.kind === "series" ? root.elements : [root];
  let split = elements.length;
  while (split > 0 && o.isOutput(elements[split - 1]!)) split -= 1;
  const conditions = elements.slice(0, split);
  const outputs = elements.slice(split);

  const leftRail = 0;
  const condOut: Out = { instrs: [], wires: [], rails: [] };
  const c = placeSeries(conditions, leftRail + o.railPad, 0, o, condOut);
  const condEnd = leftRail + o.railPad + (conditions.length ? c.w : 0);
  if (conditions.length === 0) condOut.wires.pop(); // no placeholder stub before outputs

  const outOut: Out = { instrs: [], wires: [], rails: [] };
  const r = outputs.length ? placeSeries(outputs, 0, 0, o, outOut) : { w: 0, h: 0 };

  const natural = condEnd + (outputs.length ? 40 + r.w : 40) + o.railPad;
  const width = Math.max(o.minWidth, natural);
  const rightRail = width;
  const outX = outputs.length ? rightRail - o.railPad - r.w : rightRail;

  for (const p of outOut.instrs) p.x += outX;
  for (const w of outOut.wires) {
    w.x1 += outX;
    w.x2 += outX;
  }
  for (const rl of outOut.rails) rl.x += outX;

  const powered = !!o.power;
  const outOf = (n: LadderNode | undefined) => (n ? o.power?.(n)?.out === true : powered);
  const condOn = outOf(conditions[conditions.length - 1]);
  const wires: Wire[] = [
    ...condOut.wires,
    ...outOut.wires,
    { x1: leftRail, x2: leftRail + o.railPad, y: o.lineY, on: powered },
    { x1: condEnd, x2: outX, y: o.lineY, on: condOn },
  ];
  if (outputs.length) wires.push({ x1: outX + r.w, x2: rightRail, y: o.lineY, on: outOf(outputs[outputs.length - 1]) });

  return {
    instrs: [...condOut.instrs, ...outOut.instrs],
    wires,
    rails: [...condOut.rails, ...outOut.rails],
    width,
    height: Math.max(c.h, r.h),
    leftRail,
    rightRail,
  };
}
