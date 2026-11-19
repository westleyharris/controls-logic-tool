/**
 * Evaluator for CMP / CPT / FAL style expressions, e.g.
 *   _0901_MMA_Production.O_SpeedDiv10<(ParMMA1.TP1.ConStopOpenCloseSpdLim+5)
 *   (N7:10 * 2) >= N7:11 AND NOT B3/4
 * Returns a number/boolean, or null when any operand's value is unknown.
 */

export type ExprValue = number | boolean | null;

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "(" }
  | { t: ")" }
  | { t: "," };

const WORD_OPS = new Set(["AND", "OR", "XOR", "NOT", "MOD"]);
const FUNCS: Record<string, (x: number) => number> = {
  ABS: Math.abs,
  SQR: Math.sqrt,
  SQRT: Math.sqrt,
  SIN: Math.sin,
  COS: Math.cos,
  TAN: Math.tan,
  ASN: Math.asin,
  ASIN: Math.asin,
  ACS: Math.acos,
  ACOS: Math.acos,
  ATN: Math.atan,
  ATAN: Math.atan,
  LN: Math.log,
  LOG: Math.log10,
  DEG: (x) => (x * 180) / Math.PI,
  RAD: (x) => (x * Math.PI) / 180,
  TRN: Math.trunc,
  TRUNC: Math.trunc,
};

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const rest = src.slice(i);
    let m = rest.match(/^(\d+)#([0-9A-Fa-f_]+)/);
    if (m) {
      out.push({ t: "num", v: parseInt(m[2]!.replace(/_/g, ""), Number(m[1])) });
      i += m[0].length;
      continue;
    }
    m = rest.match(/^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/);
    if (m) {
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    // Tag / address: Name.Member[1].0, Local:1:I.Data, N7:10/3, T4:1.ACC, #N7:0
    m = rest.match(/^#?[A-Za-z_][\w]*(?::[\w]+)*(?:\[[^\]]*\]|[./]\w+)*/);
    if (m) {
      const word = m[0];
      if (WORD_OPS.has(word.toUpperCase())) out.push({ t: "op", v: word.toUpperCase() });
      else out.push({ t: "id", v: word });
      i += word.length;
      continue;
    }
    m = rest.match(/^(\*\*|<>|<=|>=|=|<|>|\+|-|\*|\/|\||&)/);
    if (m) {
      const op = m[0] === "|" ? "OR" : m[0] === "&" ? "AND" : m[0];
      out.push({ t: "op", v: op });
      i += m[0].length;
      continue;
    }
    if (ch === "(") out.push({ t: "(" });
    else if (ch === ")") out.push({ t: ")" });
    else if (ch === ",") out.push({ t: "," });
    else return null;
    i += 1;
  }
  return out;
}

const PREC: Record<string, number> = {
  OR: 1,
  XOR: 2,
  AND: 3,
  "=": 4,
  "<>": 4,
  "<": 5,
  "<=": 5,
  ">": 5,
  ">=": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
  MOD: 7,
  "**": 8,
};

function num(v: ExprValue): number | null {
  if (v === null) return null;
  return typeof v === "boolean" ? (v ? 1 : 0) : v;
}

function truthy(v: ExprValue): boolean | null {
  if (v === null) return null;
  return typeof v === "boolean" ? v : v !== 0;
}

function apply(op: string, a: ExprValue, b: ExprValue): ExprValue {
  if (op === "AND" || op === "OR" || op === "XOR") {
    // Logix treats AND/OR/XOR on integers as bitwise; on booleans as logical.
    if (typeof a === "number" && typeof b === "number") {
      return op === "AND" ? a & b : op === "OR" ? a | b : a ^ b;
    }
    const x = truthy(a);
    const y = truthy(b);
    if (op === "AND") return x === false || y === false ? false : x === null || y === null ? null : true;
    if (op === "OR") return x === true || y === true ? true : x === null || y === null ? null : false;
    return x === null || y === null ? null : x !== y;
  }
  const x = num(a);
  const y = num(b);
  if (x === null || y === null) return null;
  switch (op) {
    case "+":
      return x + y;
    case "-":
      return x - y;
    case "*":
      return x * y;
    case "/":
      return y === 0 ? null : x / y;
    case "MOD":
      return y === 0 ? null : x % y;
    case "**":
      return x ** y;
    case "=":
      return x === y;
    case "<>":
      return x !== y;
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
    default:
      return null;
  }
}

export function evaluateExpression(src: string, lookup: (ref: string) => ExprValue): ExprValue {
  const toks = tokenize(src);
  if (!toks) return null;
  let i = 0;

  function primary(): ExprValue {
    const t = toks![i];
    if (!t) return null;
    if (t.t === "num") {
      i += 1;
      return t.v;
    }
    if (t.t === "(") {
      i += 1;
      const v = expr(0);
      if (toks![i]?.t === ")") i += 1;
      return v;
    }
    if (t.t === "op" && (t.v === "-" || t.v === "NOT")) {
      i += 1;
      const v = primary();
      if (t.v === "-") {
        const n = num(v);
        return n === null ? null : -n;
      }
      if (typeof v === "number") return ~v;
      const b = truthy(v);
      return b === null ? null : !b;
    }
    if (t.t === "id") {
      i += 1;
      const fn = FUNCS[t.v.toUpperCase()];
      if (fn && toks![i]?.t === "(") {
        i += 1;
        const arg = num(expr(0));
        if (toks![i]?.t === ")") i += 1;
        return arg === null ? null : fn(arg);
      }
      return lookup(t.v);
    }
    i += 1;
    return null;
  }

  function expr(minPrec: number): ExprValue {
    let left = primary();
    for (;;) {
      const t = toks![i];
      if (!t || t.t !== "op") break;
      const p = PREC[t.v];
      if (p === undefined || p < minPrec) break;
      i += 1;
      const right = expr(t.v === "**" ? p : p + 1);
      left = apply(t.v, left, right);
    }
    return left;
  }

  return expr(0);
}
