import { CLASSIC_MNEMONICS, STRUCTURAL } from "../logic/instructions.js";
import type { LadderGraph, LadderInstruction, LadderNode } from "./ast.js";

function instr(mnemonic: string, operands: string[]): LadderInstruction {
  return { kind: "instruction", mnemonic, operands };
}

function flattenSeries(elements: LadderNode[]): LadderNode {
  const flat: LadderNode[] = [];
  for (const el of elements) {
    if (el.kind === "series") flat.push(...el.elements);
    else flat.push(el);
  }
  if (flat.length === 1) return flat[0]!;
  return { kind: "series", elements: flat };
}

function isClassicMnemonic(token: string): boolean {
  return CLASSIC_MNEMONICS.has(token.toUpperCase());
}

/**
 * Parse classic AB rung body (PLC-5 / SLC mnemonic text between SOR and EOR):
 *   XIC B3/0 BST XIC I:000/1 NXB XIO T4:1/DN BND TON T4:1 0.01 50 0
 * BST/NXB/BND become parallel branches, never instructions.
 */
export function parseClassicLadder(body: string): LadderGraph {
  const tokens = body
    .trim()
    .split(/\s+/)
    .filter((t) => t && !/^(SOR|EOR)$/i.test(t));
  let i = 0;

  function parseSeriesUntil(stop: Set<string>): LadderNode {
    const elements: LadderNode[] = [];
    while (i < tokens.length) {
      const t = tokens[i]!.toUpperCase();
      if (stop.has(t)) break;

      if (t === "BST") {
        i += 1;
        const branches: LadderNode[] = [parseSeriesUntil(new Set(["NXB", "BND"]))];
        while (i < tokens.length && tokens[i]!.toUpperCase() === "NXB") {
          i += 1;
          branches.push(parseSeriesUntil(new Set(["NXB", "BND"])));
        }
        if (i < tokens.length && tokens[i]!.toUpperCase() === "BND") i += 1;
        elements.push(branches.length === 1 ? branches[0]! : { kind: "parallel", branches });
        continue;
      }

      if (t === "NXB" || t === "BND") {
        // Unbalanced structural token at top level — skip.
        i += 1;
        continue;
      }

      // Instruction: mnemonic followed by operands up to the next mnemonic.
      i += 1;
      const operands: string[] = [];
      while (i < tokens.length) {
        const n = tokens[i]!;
        if (isClassicMnemonic(n) || STRUCTURAL.has(n.toUpperCase())) break;
        operands.push(n);
        i += 1;
      }
      elements.push(instr(t, operands));
    }
    return flattenSeries(elements);
  }

  return { root: parseSeriesUntil(new Set()) };
}

/** Split on commas at depth 0 (ignores commas inside [] and ()). */
export function splitTopLevel(text: string, sep = ","): string[] {
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
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim());
}

/**
 * Parse Logix neutral text, e.g.
 *   [XIC(A),XIC(B)]XIC(C)OTE(D);
 * Nested brackets and AOI calls supported.
 */
export function parseNeutralLadder(text: string): LadderGraph {
  const src = text.replace(/;+\s*$/, "").trim();
  let i = 0;

  function skipWs() {
    while (i < src.length && /\s/.test(src[i]!)) i += 1;
  }

  function parseInstruction(): LadderNode | null {
    skipWs();
    const m = /^([A-Za-z_][\w]*)\s*\(/.exec(src.slice(i));
    if (!m) return null;
    const mnemonic = m[1]!;
    i += m[0].length;
    let depth = 1;
    let quote: string | null = null;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i]!;
      if (quote) {
        if (ch === "$") i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      i += 1;
    }
    const inside = src.slice(start, i - 1);
    const operands = inside.trim() ? splitTopLevel(inside) : [];
    return instr(mnemonic, operands);
  }

  function parseBranchList(): LadderNode {
    const branches: LadderNode[] = [];
    skipWs();
    while (i < src.length && src[i] !== "]") {
      branches.push(parseSeries());
      skipWs();
      if (src[i] === ",") {
        i += 1;
        skipWs();
        continue;
      }
      break;
    }
    if (branches.length === 1) return branches[0]!;
    return { kind: "parallel", branches };
  }

  function parseSeries(): LadderNode {
    const elements: LadderNode[] = [];
    while (i < src.length) {
      skipWs();
      const ch = src[i];
      if (!ch || ch === "]" || ch === ",") break;
      if (ch === "[") {
        i += 1;
        const branch = parseBranchList();
        skipWs();
        if (src[i] === "]") i += 1;
        elements.push(branch);
        continue;
      }
      const node = parseInstruction();
      if (!node) {
        i += 1;
        continue;
      }
      elements.push(node);
    }
    return flattenSeries(elements);
  }

  return { root: parseSeries() };
}

export function walkInstructions(node: LadderNode, visit: (ins: LadderInstruction) => void): void {
  if (node.kind === "instruction") {
    visit(node);
    return;
  }
  if (node.kind === "series") {
    for (const el of node.elements) walkInstructions(el, visit);
    return;
  }
  for (const b of node.branches) walkInstructions(b, visit);
}

export function instructionsOf(node: LadderNode | undefined): LadderInstruction[] {
  const out: LadderInstruction[] = [];
  if (node) walkInstructions(node, (ins) => out.push(ins));
  return out;
}
