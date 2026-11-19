import type { LadderNode, Rung } from "@core/model/types";
import type { ProjectIndex, Scope } from "@core/query/index";
import { instructionInfo } from "@core/logic/instructions";

/**
 * Rule-based plain-English explanations: rung summaries and why a
 * condition is keeping an output from getting power.
 */

type Where = Scope;

/** Timer / counter / control status members, in words. */
const MEMBER_WORDS: Record<string, string> = {
  DN: "done",
  TT: "timing",
  EN: "enabled",
  ACC: "accumulated",
  PRE: "preset",
  CU: "counting up",
  CD: "counting down",
  OV: "overflow",
  UN: "underflow",
  ER: "error",
  POS: "position",
  LEN: "length",
  EU: "unload enabled",
  EM: "empty",
  UL: "unload",
  IN: "inhibited",
  FD: "found",
};

export function shortName(index: ProjectIndex, ref: string | undefined, where: Where): string {
  if (!ref) return "?";
  const t = ref.trim();
  if (/^[-+]?\d/.test(t)) return t;
  const info = index.resolve(t, where);
  const desc = info.description?.split("\n").map((s) => s.trim()).filter(Boolean).join(" ");
  if (desc && desc.length <= 60) {
    const member = t.match(/[./](DN|TT|EN|ACC|PRE|CU|CD|OV|UN|ER|POS|LEN|EU|EM|UL|IN|FD)$/i)?.[1]?.toUpperCase();
    return member ? `${desc} [${MEMBER_WORDS[member]}]` : desc;
  }
  return t;
}

function isAction(node: LadderNode): boolean {
  if (node.kind === "instruction") {
    const info = instructionInfo(node.mnemonic);
    return info ? info.output === true : true; // AOIs and unknowns sit on the output side
  }
  if (node.kind === "parallel") return node.branches.every(isAction);
  return node.elements.length > 0 && node.elements.every(isAction);
}

function instrPhrase(node: Extract<LadderNode, { kind: "instruction" }>, index: ProjectIndex, where: Where): string {
  const m = node.mnemonic.toUpperCase();
  const n = (i: number) => shortName(index, node.operands[i], where);
  switch (m) {
    case "XIC":
      return `${n(0)} is ON`;
    case "XIO":
      return `${n(0)} is OFF`;
    case "ONS":
    case "OSR":
      return "on the rising edge";
    case "OSF":
      return "on the falling edge";
    case "OTE":
      return `turn ON ${n(0)}`;
    case "OTL":
      return `latch ${n(0)} ON`;
    case "OTU":
      return `unlatch ${n(0)}`;
    case "TON":
      return `run on-delay timer ${n(0)}`;
    case "TOF":
      return `run off-delay timer ${n(0)}`;
    case "RTO":
      return `run retentive timer ${n(0)}`;
    case "CTU":
      return `count up ${n(0)}`;
    case "CTD":
      return `count down ${n(0)}`;
    case "RES":
      return `reset ${n(0)}`;
    case "MOV":
      return `copy ${n(0)} into ${n(1)}`;
    case "COP":
    case "CPS":
      return `copy ${n(0)} into ${n(1)}`;
    case "FLL":
      return `fill ${n(1)} with ${n(0)}`;
    case "CLR":
      return `clear ${n(0)}`;
    case "EQU":
      return `${n(0)} = ${n(1)}`;
    case "NEQ":
      return `${n(0)} ≠ ${n(1)}`;
    case "LES":
      return `${n(0)} < ${n(1)}`;
    case "LEQ":
      return `${n(0)} ≤ ${n(1)}`;
    case "GRT":
      return `${n(0)} > ${n(1)}`;
    case "GEQ":
      return `${n(0)} ≥ ${n(1)}`;
    case "LIM":
      return `${n(1)} is between ${n(0)} and ${n(2)}`;
    case "CMP":
      return `${node.operands[0] ?? ""} is true`;
    case "ADD":
      return `${n(2)} = ${n(0)} + ${n(1)}`;
    case "SUB":
      return `${n(2)} = ${n(0)} − ${n(1)}`;
    case "MUL":
      return `${n(2)} = ${n(0)} × ${n(1)}`;
    case "DIV":
      return `${n(2)} = ${n(0)} ÷ ${n(1)}`;
    case "CPT":
      return `${n(0)} = ${node.operands[1] ?? ""}`;
    case "JSR":
      return `run routine ${node.operands[0] ?? ""}`;
    case "JMP":
      return `jump to label ${node.operands[0] ?? ""}`;
    case "MSG":
      return `send message ${n(0)}`;
    case "NOP":
      return "do nothing";
    case "AFI":
      return "never (AFI — always false)";
    case "TND":
      return "end the scan here";
    default: {
      const aoi = index.aoi(node.mnemonic);
      if (aoi) return `run ${aoi.description?.split("\n")[0] ?? node.mnemonic} (${node.operands[0] ?? ""})`;
      return node.operands[0] ? `${m} ${n(0)}` : m;
    }
  }
}

function phrase(node: LadderNode, index: ProjectIndex, where: Where): string {
  if (node.kind === "instruction") return instrPhrase(node, index, where);
  if (node.kind === "parallel") {
    const parts = node.branches.map((b) => phrase(b, index, where)).filter(Boolean);
    if (parts.length <= 1) return parts[0] ?? "";
    return `(${parts.join(" OR ")})`;
  }
  return node.elements
    .map((el) => phrase(el, index, where))
    .filter(Boolean)
    .join(" AND ");
}

export interface RungSummary {
  conditions: string;
  actions: string;
}

/** Split a rung into "when …" conditions and "then …" actions. */
export function summarizeRung(rung: Rung, index: ProjectIndex, where: Where): RungSummary {
  const root = rung.ladder;
  if (!root) return { conditions: "", actions: rung.text };
  const elements = root.kind === "series" ? [...root.elements] : [root];
  let split = elements.length;
  while (split > 0 && isAction(elements[split - 1]!)) split -= 1;
  const conditions = elements
    .slice(0, split)
    .map((n) => phrase(n, index, where))
    .filter(Boolean)
    .join(" AND ");
  const actions = elements
    .slice(split)
    .map((n) => phrase(n, index, where))
    .filter(Boolean)
    .join("; ");
  return { conditions, actions };
}

/** Drop PLC-5 banner blocks (rows of ***** / ....) from rung comments. */
export function tidyComment(comment?: string): string | undefined {
  if (!comment) return undefined;
  const lines = comment
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => !/^\s*[*=#\-_.]{6,}\s*$/.test(l));
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || undefined;
}

/* ------------------------------ blockers ------------------------------ */

export interface BlockerText {
  text: string;
  ref?: string;
}

function valueText(index: ProjectIndex, ref: string | undefined, where: Where): string {
  if (!ref) return "?";
  if (/^[-+]?\d/.test(ref.trim())) return ref.trim();
  const r = index.resolve(ref, where);
  if (!r.hasValue || r.value === undefined || typeof r.value === "object") return "unknown";
  if (typeof r.value === "boolean") return r.value ? "ON" : "OFF";
  return String(Number.isInteger(r.value as number) ? r.value : Number((r.value as number).toPrecision(7)));
}

/** Why one condition instruction isn't passing power, in plain words. */
export function describeBlocker(
  node: Extract<LadderNode, { kind: "instruction" }>,
  state: boolean | null,
  index: ProjectIndex,
  where: Where,
): BlockerText {
  const m = node.mnemonic.toUpperCase();
  const [a, b, c] = node.operands;
  const name = (r?: string) => {
    const s = shortName(index, r, where);
    return s !== r && r ? `${r} (${s})` : (r ?? "?");
  };
  const unknown = state === null;
  const ref = a && !/^[-+]?\d/.test(a) ? a : undefined;
  const withRef = (text: string): BlockerText => (ref ? { text, ref } : { text });
  switch (m) {
    case "XIC":
      return withRef(unknown ? `${name(a)} must be ON — its value isn't in the export` : `${name(a)} must be ON — it's OFF`);
    case "XIO":
      return withRef(unknown ? `${name(a)} must be OFF — its value isn't in the export` : `${name(a)} must be OFF — it's ON`);
    case "ONS":
      return withRef(`One-shot ${a} already fired (its storage bit is ON), so it only passes power for one scan`);
    case "AFI":
      return { text: "AFI (Always False) — this rung is deliberately disabled" };
    case "EQU":
    case "NEQ":
    case "LES":
    case "LEQ":
    case "GRT":
    case "GEQ": {
      const sym = { EQU: "=", NEQ: "≠", LES: "<", LEQ: "≤", GRT: ">", GEQ: "≥" }[m];
      return withRef(
        `${name(a)} ${sym} ${name(b)} is ${unknown ? "unknown" : "false"} (${valueText(index, a, where)} vs ${valueText(index, b, where)})`,
      );
    }
    case "LIM":
      return {
        text: `${name(b)} must be between ${valueText(index, a, where)} and ${valueText(index, c, where)} — it's ${valueText(index, b, where)}`,
        ...(b && !/^[-+]?\d/.test(b) ? { ref: b } : {}),
      };
    case "CMP":
      return { text: `Expression ${a ?? ""} is ${unknown ? "unknown" : "false"}` };
    default: {
      const aoi = index.aoi(node.mnemonic);
      if (aoi) return withRef(`${aoi.name} (${a}) has EnableOut OFF`);
      return withRef(`${m} ${a ?? ""} is ${unknown ? "unknown" : "not passing power"}`);
    }
  }
}

/* ---------------------------- per-output summary ---------------------------- */

/** "When <when>: <actions>" with nested cases that need extra conditions. */
export interface ExplainNode {
  when: string;
  actions: string[];
  children: ExplainNode[];
}

function isOutputInstr(node: Extract<LadderNode, { kind: "instruction" }>): boolean {
  const info = instructionInfo(node.mnemonic);
  return info ? info.output === true : true;
}

/** Conditions in a node, ignoring output instructions (they pass power). null = always passes. */
function condPhrase(node: LadderNode, index: ProjectIndex, where: Where): string | null {
  if (node.kind === "instruction") return isOutputInstr(node) ? null : instrPhrase(node, index, where);
  if (node.kind === "series") {
    const parts = node.elements.map((e) => condPhrase(e, index, where)).filter((p): p is string => !!p);
    return parts.length ? parts.join(" AND ") : null;
  }
  const parts = node.branches.map((b) => condPhrase(b, index, where));
  if (parts.some((p) => p === null)) return null;
  return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
}

interface RawOutput {
  action: string;
  conds: string[];
}

function nest(entries: RawOutput[], depth: number): { actions: string[]; children: ExplainNode[] } {
  const actions = entries.filter((e) => e.conds.length === depth).map((e) => e.action);
  const order: string[] = [];
  const byCond = new Map<string, RawOutput[]>();
  for (const e of entries) {
    if (e.conds.length === depth) continue;
    const key = e.conds[depth]!;
    if (!byCond.has(key)) {
      byCond.set(key, []);
      order.push(key);
    }
    byCond.get(key)!.push(e);
  }
  const children = order.map((key): ExplainNode => {
    const group = byCond.get(key)!;
    if (group.length === 1) {
      const only = group[0]!;
      return { when: only.conds.slice(depth).join(" AND "), actions: [only.action], children: [] };
    }
    const sub = nest(group, depth + 1);
    const node: ExplainNode = { when: key, actions: sub.actions, children: sub.children };
    // Fold single-child chains: "When A:" → "When B:" becomes "When A AND B:".
    while (node.actions.length === 0 && node.children.length === 1) {
      const c = node.children[0]!;
      node.when = `${node.when} AND ${c.when}`;
      node.actions = c.actions;
      node.children = c.children;
    }
    return node;
  });
  return { actions, children };
}

/**
 * What each output on the rung does and when, as a tree: outputs that share
 * conditions sit under one "When …" line, extra conditions nest below it.
 */
export function explainOutputs(rung: Rung, index: ProjectIndex, where: Where): ExplainNode {
  const raw: RawOutput[] = [];
  const walk = (node: LadderNode, conds: string[]) => {
    if (node.kind === "instruction") {
      if (isOutputInstr(node)) raw.push({ action: instrPhrase(node, index, where), conds });
      return;
    }
    if (node.kind === "series") {
      const acc = [...conds];
      for (const el of node.elements) {
        walk(el, [...acc]);
        const c = condPhrase(el, index, where);
        if (c) acc.push(c);
      }
      return;
    }
    for (const b of node.branches) walk(b, conds);
  };
  if (rung.ladder) walk(rung.ladder, []);
  const top = nest(raw, 0);
  return { when: "", actions: top.actions, children: top.children };
}
