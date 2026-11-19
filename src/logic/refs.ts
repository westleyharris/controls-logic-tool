/**
 * Turning instruction operands into tag / address references, and
 * canonicalizing PLC-5 / SLC addresses so that `T4:1.DN`, `T4:1/DN`,
 * `B3:5/3` and `B3/83` line up in the cross reference.
 */

import { EXPRESSION_KEYWORDS, instructionInfo } from "./instructions.js";

export type Dialect = "classic" | "logix";

const NUMERIC = /^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const RADIX_LITERAL = /^[-+]?\d+#[0-9A-Fa-f_]+$/;

export function isConstant(operand: string): boolean {
  const t = operand.trim();
  if (!t || t === "?" || t === "??") return true;
  if (NUMERIC.test(t) || RADIX_LITERAL.test(t)) return true;
  if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return true;
  return false;
}

/* ------------------------------ PLC-5 / SLC ------------------------------ */

const STRUCT_FILE_TYPES = new Set(["T", "C", "R", "BT", "MG", "PD", "SC", "ST", "CT"]);

export interface ClassicAddress {
  /** File label: "I", "O", "S", "B3", "N7", "T4" … */
  file: string;
  type: string;
  number?: number;
  /** Element (word) index, decimal. */
  element?: number;
  /** Bit number (decimal) or structure member like DN / ACC. */
  bit?: number;
  member?: string;
  /** SLC 500 I/O: chassis slot (I:2.0/5 → slot 2, word 0, bit 5). */
  slot?: number;
  /** Bit written as word/bit (B3:0/12) rather than file/bit (B3/12) — kept so addresses read as in the source. */
  wordBit?: boolean;
}

/** Parse `I:004/7`, `B3/12`, `B3:5/3`, `N7:30/0`, `T4:13/DN`, `T4:13.ACC`, `#N7:0`, `S:1/15`. */
export function parseClassicAddress(raw: string): ClassicAddress | null {
  const a = raw.trim().replace(/^#/, "").toUpperCase();
  // SLC 500 I/O: I:2.0/5 (slot.word/bit, all decimal)
  let m = a.match(/^([IO]):(\d+)\.(\d+)(?:\/(\d+))?$/);
  if (m) {
    const out: ClassicAddress = { file: `${m[1]}:${Number(m[2])}`, type: m[1]!, slot: Number(m[2]), element: Number(m[3]) };
    if (m[4] !== undefined) out.bit = Number(m[4]);
    return out;
  }
  // PLC-5 I/O: I:004/7 or I:4/07 (octal word and bit)
  m = a.match(/^([IO]):(\d+)(?:\/(\d+))?$/);
  if (m) {
    const out: ClassicAddress = { file: m[1]!, type: m[1]!, element: parseInt(m[2]!, 8) };
    if (m[3] !== undefined) out.bit = parseInt(m[3], 8);
    return out;
  }
  // Status: S:1/15 or S2:1/15
  m = a.match(/^S\d*:(\d+)(?:\/(\d+))?$/);
  if (m) {
    const out: ClassicAddress = { file: "S", type: "S", element: Number(m[1]) };
    if (m[2] !== undefined) out.bit = Number(m[2]);
    return out;
  }
  // Bit-file shorthand: B3/12
  m = a.match(/^([A-Z]{1,2})(\d+)\/(\d+)$/);
  if (m) {
    const n = Number(m[3]);
    return {
      file: `${m[1]}${m[2]}`,
      type: m[1]!,
      number: Number(m[2]),
      element: Math.floor(n / 16),
      bit: n % 16,
    };
  }
  // Element with optional bit or member: N7:30/0, T4:13/DN, T4:13.ACC, N7:10
  m = a.match(/^([A-Z]{1,2})(\d+):(\d+)(?:([./])(\w+))?$/);
  if (m) {
    const out: ClassicAddress = {
      file: `${m[1]}${m[2]}`,
      type: m[1]!,
      number: Number(m[2]),
      element: Number(m[3]),
    };
    const sub = m[5];
    if (sub !== undefined) {
      if (/^\d+$/.test(sub)) {
        out.bit = Number(sub);
        if (out.type === "B") out.wordBit = true;
      } else out.member = sub;
    }
    return out;
  }
  return null;
}

function pad3Octal(n: number): string {
  return n.toString(8).padStart(3, "0");
}

export function formatClassicAddress(a: ClassicAddress): string {
  if ((a.type === "I" || a.type === "O") && a.slot !== undefined) {
    const word = `${a.type}:${a.slot}.${a.element ?? 0}`;
    return a.bit !== undefined ? `${word}/${a.bit}` : word;
  }
  if (a.type === "I" || a.type === "O") {
    const word = `${a.type}:${pad3Octal(a.element ?? 0)}`;
    return a.bit !== undefined ? `${word}/${a.bit.toString(8)}` : word;
  }
  if (a.type === "S") {
    return a.bit !== undefined ? `S:${a.element}/${a.bit}` : `S:${a.element}`;
  }
  if (a.type === "B" && a.bit !== undefined && a.member === undefined && !a.wordBit) {
    return `${a.file}/${(a.element ?? 0) * 16 + a.bit}`;
  }
  const el = `${a.file}:${a.element ?? 0}`;
  if (a.member) {
    const isBitMember = !["ACC", "PRE", "LEN", "POS", "CTL", "RLEN", "DLEN", "FILE", "ELEM", "RGS"].includes(
      a.member,
    );
    return `${el}${isBitMember ? "/" : "."}${a.member}`;
  }
  if (a.bit !== undefined) return `${el}/${a.bit}`;
  return el;
}

export function canonicalClassic(raw: string): string {
  const parsed = parseClassicAddress(raw);
  return parsed ? formatClassicAddress(parsed) : raw.trim().toUpperCase();
}

/** Base element for grouping: `T4:13/DN` → `T4:13`; other addresses are their own base. */
export function classicBase(canonical: string): string {
  const a = parseClassicAddress(canonical);
  if (!a) return canonical;
  if (STRUCT_FILE_TYPES.has(a.type) && a.element !== undefined) return `${a.file}:${a.element}`;
  return canonical;
}

export function looksLikeClassicAddress(token: string): boolean {
  return parseClassicAddress(token) !== null;
}

/* --------------------------------- Logix --------------------------------- */

/** Tag path: Name, Name.Member, Name[1].X.0, Local:1:I.Data.3, Program:Main.Tag */
const LOGIX_PATH =
  /[A-Za-z_][\w]*(?::[A-Za-z_\d]\w*)*(?:\[[^\]]*\]|\.[A-Za-z_\d]\w*)*/g;

export function logixBase(path: string): string {
  const m = path.match(/^(Program:[A-Za-z_]\w*\.)?([A-Za-z_][\w]*(?::[\w]+)*)/);
  if (!m) return path;
  return `${m[1] ?? ""}${m[2]}`;
}

function extractExpressionRefs(expr: string, dialect: Dialect): string[] {
  const out: string[] = [];
  if (dialect === "classic") {
    for (const m of expr.matchAll(/[IO]:\d+\.\d+(?:\/\d+)?|#?[A-Z]{1,2}\d*:\d+(?:[./]\w+)?|[A-Z]{1,2}\d+\/\d+|[IO]:\d+(?:\/\d+)?/gi)) {
      out.push(canonicalClassic(m[0]));
    }
    return out;
  }
  for (const m of expr.matchAll(LOGIX_PATH)) {
    const token = m[0];
    const after = expr.slice((m.index ?? 0) + token.length).trimStart();
    if (EXPRESSION_KEYWORDS.has(token.toUpperCase()) && (after.startsWith("(") || !/[.[]/.test(token))) {
      continue;
    }
    // Skip exponent parts of numbers like 1.5e+001
    const before = expr.slice(0, m.index ?? 0);
    if (/\d\.?$/.test(before) && /^e/i.test(token)) continue;
    out.push(token);
  }
  return out;
}

/** References used by one operand of an instruction. */
export function operandRefs(
  mnemonic: string,
  operandIndex: number,
  operand: string,
  dialect: Dialect,
): string[] {
  const t = operand.trim();
  if (isConstant(t)) return [];
  const info = instructionInfo(mnemonic);
  const isExpr =
    info?.expr?.includes(operandIndex) ||
    (dialect === "logix" ? /[\s+\-*/<>=()]/.test(t.replace(/\[[^\]]*\]/g, "")) : /[()+*<>=]/.test(t));
  if (isExpr) return extractExpressionRefs(t, dialect);

  if (dialect === "classic") {
    // Indirect addressing like N7:[N7:0] — reference the pointer word.
    if (t.includes("[")) return extractExpressionRefs(t.replace(/[[\]]/g, " "), "classic");
    if (looksLikeClassicAddress(t)) return [canonicalClassic(t)];
    return [];
  }

  // Logix: JSR / GSV / SSV class & attribute names, JMP labels aren't tags.
  const m = mnemonic.toUpperCase();
  if (m === "JSR" && operandIndex === 0) return [];
  if ((m === "GSV" || m === "SSV") && operandIndex < 3) return [];
  if (m === "JMP" || m === "LBL") return [];
  if (/^[A-Za-z_]/.test(t)) {
    // Indexed with tags: Tag[Idx] — reference both the array and the index tags.
    const refs = [t];
    for (const idx of t.matchAll(/\[([^\]]+)\]/g)) {
      for (const inner of idx[1]!.split(",")) {
        if (!isConstant(inner)) refs.push(...extractExpressionRefs(inner, "logix"));
      }
    }
    return refs;
  }
  return [];
}

/** Whether the instruction writes operand `index` (AOI calls handled by the caller). */
export function operandWrites(mnemonic: string, index: number): boolean {
  return instructionInfo(mnemonic)?.write?.includes(index) ?? false;
}

/**
 * Is this operand a single tag / address (as opposed to a constant or an
 * expression)? PLC-5 addresses contain "/" (B3/7), so the rule depends on the platform.
 */
export function isTagOperand(operand: string, dialect: Dialect): boolean {
  const t = operand.trim();
  if (isConstant(t)) return false;
  if (dialect === "classic") return looksLikeClassicAddress(t);
  return /^[A-Za-z_]/.test(t) && !/[\s+\-*/<>=()]/.test(t.replace(/\[[^\]]*\]/g, ""));
}
