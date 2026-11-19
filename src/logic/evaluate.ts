/**
 * Static power-flow evaluation of a rung against the values saved in the
 * export. Tri-state: true / false / null (unknown). This is a snapshot
 * evaluation — it ignores scan order and anything that changed after the
 * file was saved.
 */

import type { LadderNode, SavedValue } from "../model/types.js";
import type { LadderInstruction } from "../ladder/ast.js";
import { evaluateExpression, type ExprValue } from "./expr.js";
import { instructionInfo } from "./instructions.js";
import { isConstant } from "./refs.js";

export type Tri = boolean | null;

export interface EvalContext {
  /** Saved value of a tag / address operand (undefined when unknown). */
  value(ref: string): SavedValue | undefined;
  /** True when the mnemonic is an Add-On Instruction. */
  isAoi(mnemonic: string): boolean;
}

export interface NodeState {
  /** Power arriving at the node's left side. */
  in: Tri;
  /** Power leaving the node's right side. */
  out: Tri;
  /** For instructions: would it pass power if its input were true? */
  cond?: Tri;
}

export type Blocker =
  | { kind: "instr"; node: LadderInstruction; state: Tri }
  | { kind: "anyOf"; branches: Blocker[][] };

export interface RungEvaluation {
  states: Map<LadderNode, NodeState>;
  /** Power at the rung's right side. */
  out: Tri;
  /** Conditions on the path to `target` that are keeping it from getting power. */
  blockers(target: LadderNode): Blocker[];
  /** Every condition on the path to `target`, satisfied or not (for checklists). */
  requirements(target: LadderNode): Blocker[];
  /** Output instructions in the rung, in order. */
  outputs: LadderInstruction[];
}

const and = (a: Tri, b: Tri): Tri => (a === false || b === false ? false : a === null || b === null ? null : true);
const or = (xs: Tri[]): Tri => (xs.some((x) => x === true) ? true : xs.every((x) => x === false) ? false : null);

function parseConstant(text: string): number | null {
  const t = text.trim();
  const radix = t.match(/^([-+]?)(\d+)#([0-9A-Fa-f_]+)$/);
  if (radix) {
    const n = parseInt(radix[3]!.replace(/_/g, ""), Number(radix[2]));
    return radix[1] === "-" ? -n : n;
  }
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? n : null;
}

export function isOutputInstruction(ins: LadderInstruction, isAoi: (m: string) => boolean): boolean {
  const info = instructionInfo(ins.mnemonic);
  if (info) return info.output === true;
  void isAoi;
  return true; // AOIs and instructions we don't know sit on the output side
}

export function evaluateRung(root: LadderNode, ctx: EvalContext): RungEvaluation {
  const toNum = (op: string | undefined): number | null => {
    if (op === undefined) return null;
    if (isConstant(op)) return parseConstant(op);
    const v = ctx.value(op);
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    return null;
  };
  const toBool = (op: string | undefined): Tri => {
    if (op === undefined) return null;
    const v = ctx.value(op);
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return null;
  };
  const compare = (a: string | undefined, b: string | undefined, fn: (x: number, y: number) => boolean): Tri => {
    const x = toNum(a);
    const y = toNum(b);
    return x === null || y === null ? null : fn(x, y);
  };
  const lookup = (ref: string): ExprValue => {
    const v = ctx.value(ref);
    return typeof v === "number" || typeof v === "boolean" ? v : null;
  };

  const condition = (ins: LadderInstruction): Tri => {
    const m = ins.mnemonic.toUpperCase();
    const [a, b, c] = ins.operands;
    switch (m) {
      case "XIC":
        return toBool(a);
      case "XIO": {
        const v = toBool(a);
        return v === null ? null : !v;
      }
      case "ONS": {
        // Passes power only on the scan the rung goes true; in steady state it's latched.
        const s = toBool(a);
        return s === null ? null : !s;
      }
      case "EQU":
        return compare(a, b, (x, y) => x === y);
      case "NEQ":
        return compare(a, b, (x, y) => x !== y);
      case "LES":
        return compare(a, b, (x, y) => x < y);
      case "LEQ":
        return compare(a, b, (x, y) => x <= y);
      case "GRT":
        return compare(a, b, (x, y) => x > y);
      case "GEQ":
        return compare(a, b, (x, y) => x >= y);
      case "LIM": {
        const lo = toNum(a);
        const t = toNum(b);
        const hi = toNum(c);
        if (lo === null || t === null || hi === null) return null;
        return lo <= hi ? t >= lo && t <= hi : t >= lo || t <= hi;
      }
      case "MEQ": {
        const s = toNum(a);
        const mask = toNum(b);
        const cmp = toNum(c);
        if (s === null || mask === null || cmp === null) return null;
        return (s & mask) === (cmp & mask);
      }
      case "CMP": {
        const r = a !== undefined ? evaluateExpression(a, lookup) : null;
        return r === null ? null : typeof r === "boolean" ? r : r !== 0;
      }
      case "AFI":
        return false;
      case "LBL":
      case "SBR":
        return true;
      default: {
        if (ctx.isAoi(ins.mnemonic) && a) {
          // An AOI's rung-out is its EnableOut.
          const eo = ctx.value(`${a}.EnableOut`);
          return typeof eo === "boolean" ? eo : true;
        }
        const info = instructionInfo(m);
        if (!info) return true;
        return info.output ? true : null;
      }
    }
  };

  const states = new Map<LadderNode, NodeState>();
  const parents = new Map<LadderNode, { parent: LadderNode; index: number }>();

  const run = (node: LadderNode, input: Tri, into: Map<LadderNode, NodeState>, track: boolean): Tri => {
    if (node.kind === "instruction") {
      const cond = condition(node);
      const out = and(input, cond);
      into.set(node, { in: input, out, cond });
      return out;
    }
    if (node.kind === "series") {
      let cur = input;
      node.elements.forEach((el, index) => {
        if (track) parents.set(el, { parent: node, index });
        cur = run(el, cur, into, track);
      });
      into.set(node, { in: input, out: cur });
      return cur;
    }
    const outs = node.branches.map((b, index) => {
      if (track) parents.set(b, { parent: node, index });
      return run(b, input, into, track);
    });
    const out = or(outs);
    into.set(node, { in: input, out });
    return out;
  };

  const out = run(root, true, states, true);

  // Would this node pass power if power reached it? (independent of upstream)
  const condCache = new Map<LadderNode, Tri>();
  const condOut = (node: LadderNode): Tri => {
    if (condCache.has(node)) return condCache.get(node)!;
    const scratch = new Map<LadderNode, NodeState>();
    const r = run(node, true, scratch, false);
    condCache.set(node, r);
    return r;
  };

  const blockersOf = (node: LadderNode): Blocker[] => {
    if (condOut(node) === true) return [];
    if (node.kind === "instruction") return [{ kind: "instr", node, state: condition(node) }];
    if (node.kind === "series") return node.elements.flatMap(blockersOf);
    return [{ kind: "anyOf", branches: node.branches.map(blockersOf) }];
  };

  const blockers = (target: LadderNode): Blocker[] => {
    const levels: LadderNode[][] = [];
    let n: LadderNode = target;
    for (let p = parents.get(n); p; p = parents.get(n)) {
      if (p.parent.kind === "series") levels.unshift(p.parent.elements.slice(0, p.index));
      n = p.parent;
    }
    return levels.flat().flatMap(blockersOf);
  };

  const requirementsOf = (node: LadderNode): Blocker[] => {
    if (node.kind === "instruction") {
      const isAoi = ctx.isAoi(node.mnemonic);
      if (!isAoi && isOutputInstruction(node, ctx.isAoi)) return [];
      return [{ kind: "instr", node, state: condition(node) }];
    }
    if (node.kind === "series") return node.elements.flatMap(requirementsOf);
    const branches = node.branches.map(requirementsOf);
    // A branch with no conditions always passes, so the group never blocks.
    if (branches.some((b) => b.length === 0)) return [];
    return [{ kind: "anyOf", branches }];
  };

  const requirements = (target: LadderNode): Blocker[] => {
    const levels: LadderNode[][] = [];
    let n: LadderNode = target;
    for (let p = parents.get(n); p; p = parents.get(n)) {
      if (p.parent.kind === "series") levels.unshift(p.parent.elements.slice(0, p.index));
      n = p.parent;
    }
    return levels.flat().flatMap(requirementsOf);
  };

  const outputs: LadderInstruction[] = [];
  const collect = (node: LadderNode) => {
    if (node.kind === "instruction") {
      if (isOutputInstruction(node, ctx.isAoi)) outputs.push(node);
    } else if (node.kind === "series") node.elements.forEach(collect);
    else node.branches.forEach(collect);
  };
  collect(root);

  return { states, out, blockers, requirements, outputs };
}
