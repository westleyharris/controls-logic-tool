/**
 * L5K tag value literals → structured values, using UDT / AOI layouts.
 *
 *   Tmr : TIMER := [1664819,30000,0];                   → { EN, TT, DN, PRE, ACC }
 *   Cfg : Config := [[7,'LABELER'],2,18,…];             → UDT members (hidden SINT hosts carry BIT members)
 *   Dly : _0000_DelayOnOff := [768,1,100,…,[0,0,0],…];  → AOI: packed BOOL DINT(s) first, then
 *                                                        non-BOOL parameters, then non-BOOL locals
 */

import type { AoiDefinition, DataTypeDef, SavedValue, TagRecord } from "../model/types.js";

export type RawValue = number | string | RawValue[];

/* ------------------------------ literal parser ----------------------------- */

function decodeLogixString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "$") {
      out += ch;
      continue;
    }
    const next = body[i + 1] ?? "";
    if (/[0-9A-Fa-f]/.test(next) && /[0-9A-Fa-f]/.test(body[i + 2] ?? "")) {
      const code = parseInt(body.slice(i + 1, i + 3), 16);
      if (code !== 0) out += String.fromCharCode(code);
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
      case "R":
      case "P":
        break;
      case "Q":
        out += '"';
        break;
      default:
        out += next;
    }
  }
  return out;
}

export function parseValueLiteral(text: string): RawValue | undefined {
  let i = 0;
  const s = text;

  function ws() {
    while (i < s.length && /\s/.test(s[i]!)) i += 1;
  }

  function value(): RawValue | undefined {
    ws();
    const ch = s[i];
    if (ch === undefined) return undefined;
    if (ch === "[") {
      i += 1;
      const items: RawValue[] = [];
      ws();
      if (s[i] === "]") {
        i += 1;
        return items;
      }
      while (i < s.length) {
        const v = value();
        items.push(v ?? 0);
        ws();
        if (s[i] === ",") {
          i += 1;
          continue;
        }
        if (s[i] === "]") {
          i += 1;
          break;
        }
        // Unexpected token: bail out of this list.
        break;
      }
      return items;
    }
    if (ch === "'") {
      i += 1;
      const start = i;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "$") i += 1;
        i += 1;
      }
      const body = s.slice(start, i);
      i += 1;
      return decodeLogixString(body);
    }
    const m = /^[^,\]\s]+/.exec(s.slice(i));
    if (!m) {
      i += 1;
      return undefined;
    }
    i += m[0].length;
    const tok = m[0];
    const radix = tok.match(/^(-?)(\d+)#([0-9A-Fa-f_]+)$/);
    if (radix) {
      const n = parseInt(radix[3]!.replace(/_/g, ""), Number(radix[2]));
      return radix[1] ? -n : n;
    }
    const n = Number(tok);
    return Number.isNaN(n) ? Number.NaN : n;
  }

  return value();
}

/* --------------------------------- decoding -------------------------------- */

export interface TypeRegistry {
  dataTypes: Map<string, DataTypeDef>;
  aois: Map<string, AoiDefinition>;
}

const INT_TYPES = new Set(["SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT", "REAL", "LREAL"]);

/** STRING literal `[LEN,'text…']` — only the first LEN characters are real; the rest is leftover data. */
function stringValue(raw: RawValue[]): string {
  const text = typeof raw[1] === "string" ? raw[1] : "";
  const len = typeof raw[0] === "number" ? raw[0] : text.length;
  return len >= 0 && len < text.length ? text.slice(0, len) : text;
}

function bits(word: number, names: [string, number][]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, bit] of names) out[name] = ((word >>> bit) & 1) === 1;
  return out;
}

function builtin(type: string, raw: RawValue): SavedValue | undefined {
  const t = type.toUpperCase();
  if (t === "BOOL") return typeof raw === "number" ? raw !== 0 : undefined;
  if (INT_TYPES.has(t)) return typeof raw === "number" ? raw : undefined;
  if (!Array.isArray(raw)) return undefined;
  const n = (k: number) => (typeof raw[k] === "number" ? (raw[k] as number) : 0);
  switch (t) {
    case "TIMER":
      return { ...bits(n(0), [["EN", 31], ["TT", 30], ["DN", 29]]), PRE: n(1), ACC: n(2) };
    case "COUNTER":
      return {
        ...bits(n(0), [["CU", 31], ["CD", 30], ["DN", 29], ["OV", 28], ["UN", 27]]),
        PRE: n(1),
        ACC: n(2),
      };
    case "CONTROL":
      return {
        ...bits(n(0), [["EN", 31], ["EU", 30], ["DN", 29], ["EM", 28], ["ER", 27], ["UL", 26], ["IN", 25], ["FD", 24]]),
        LEN: n(1),
        POS: n(2),
      };
    case "STRING":
      return stringValue(raw);
    default:
      return undefined;
  }
}

function isStringType(def: DataTypeDef): boolean {
  if (def.family?.toLowerCase() === "stringfamily") return true;
  const names = def.members.map((m) => m.name.toUpperCase());
  return names.length === 2 && names[0] === "LEN" && names[1] === "DATA";
}

function flattenRaw(raw: RawValue[], levels: number): RawValue[] {
  if (levels <= 0) return raw;
  const out: RawValue[] = [];
  for (const item of raw) {
    if (Array.isArray(item)) out.push(...flattenRaw(item, levels - 1));
    else out.push(item);
  }
  return out;
}

export interface DecodeStats {
  decoded: number;
  mismatched: number;
  unknownTypes: Set<string>;
}

export function decodeValue(
  type: string,
  dims: number[] | undefined,
  raw: RawValue,
  reg: TypeRegistry,
  stats?: DecodeStats,
): SavedValue | undefined {
  if (dims && dims.length > 0) {
    if (!Array.isArray(raw)) return undefined;
    const total = dims.reduce((a, b) => a * b, 1);
    if (type.toUpperCase() === "BOOL") {
      // BOOL arrays are stored as packed DINT words.
      if (raw.length < total) {
        const out: boolean[] = [];
        for (let k = 0; k < total; k++) {
          const w = raw[Math.floor(k / 32)];
          out.push(typeof w === "number" && ((w >>> (k % 32)) & 1) === 1);
        }
        return out;
      }
      return raw.map((v) => v !== 0);
    }
    const flat = dims.length > 1 && raw.length !== total ? flattenRaw(raw, dims.length - 1) : raw;
    return flat.map((item) => decodeValue(type, undefined, item, reg, stats) ?? 0);
  }

  const direct = builtin(type, raw);
  if (direct !== undefined) return direct;

  const key = type.toUpperCase();
  const udt = reg.dataTypes.get(key);
  if (udt) {
    if (!Array.isArray(raw)) return undefined;
    if (isStringType(udt)) return stringValue(raw);
    return decodeUdt(udt, raw, reg, stats);
  }

  const aoi = reg.aois.get(key);
  if (aoi) {
    if (!Array.isArray(raw)) return undefined;
    return decodeAoi(aoi, raw, reg, stats);
  }

  stats?.unknownTypes.add(type);
  return undefined;
}

function decodeUdt(def: DataTypeDef, raw: RawValue[], reg: TypeRegistry, stats?: DecodeStats): SavedValue {
  const out: Record<string, SavedValue> = {};
  const hosts = new Map<string, number>();
  let k = 0;
  const storage = def.members.filter((m) => !m.bitOf);
  if (storage.length !== raw.length && stats) stats.mismatched += 1;
  for (const m of storage) {
    const v = raw[k++];
    if (v === undefined) break;
    if (m.hidden) {
      if (typeof v === "number") hosts.set(m.name.toUpperCase(), v);
      continue;
    }
    const dims = m.dims ? [m.dims] : undefined;
    const decoded = decodeValue(m.dataType, dims, v, reg, stats);
    if (decoded !== undefined) out[m.name] = decoded;
  }
  for (const m of def.members) {
    if (!m.bitOf) continue;
    const host = hosts.get(m.bitOf.host.toUpperCase());
    if (host !== undefined) out[m.name] = ((host >>> m.bitOf.bit) & 1) === 1;
  }
  if (stats) stats.decoded += 1;
  return out;
}

function isPackedBool(t: TagRecord): boolean {
  return t.dataType.toUpperCase() === "BOOL" && !(t.dims && t.dims.length);
}

function decodeAoi(def: AoiDefinition, raw: RawValue[], reg: TypeRegistry, stats?: DecodeStats): SavedValue {
  const out: Record<string, SavedValue> = {};
  const members = [...def.parameters, ...def.localTags];
  const bools = members.filter((m) => isPackedBool(m) && m.usage?.toLowerCase() !== "inout");
  // InOut parameters are references, not stored in the instance.
  const stored = members.filter((m) => !isPackedBool(m) && m.usage?.toLowerCase() !== "inout");
  let packWords = Math.ceil(bools.length / 32);
  if (packWords + stored.length !== raw.length) {
    // Source-protected AOIs hide their local tags, so a mismatch is expected there.
    if (stats && !def.encoded) stats.mismatched += 1;
    const inferred = raw.length - stored.length;
    if (inferred >= 1 && inferred <= 8) packWords = inferred;
  }
  bools.forEach((b, idx) => {
    const word = raw[Math.floor(idx / 32)];
    if (typeof word === "number" && Math.floor(idx / 32) < packWords) {
      out[b.name] = ((word >>> (idx % 32)) & 1) === 1;
    }
  });
  let k = packWords;
  for (const m of stored) {
    const v = raw[k++];
    if (v === undefined) break;
    const decoded = decodeValue(m.dataType, m.dims, v, reg, stats);
    if (decoded !== undefined) out[m.name] = decoded;
  }
  if (stats) stats.decoded += 1;
  return out;
}
