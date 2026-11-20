/**
 * FactoryTalk View archive streams (.MER runtime files and .APA project
 * archives). Each stream inside the compound file is stored as chunks:
 *
 *   uint32 length (bytes after this field) | uint16 stored (1) / packed (0) | uint16 marker | payload
 *
 * Packed payloads use a small LZSS variant: a uint16 flag word for every 16
 * tokens (least significant bit first, set = copy). A copy token is two bytes,
 * b0 = (offset_hi << 4) | (length - 1) and b1 = offset_lo, copying 1–16 bytes
 * from up to 4095 bytes back. Worked out from real files; streams that don't
 * walk cleanly as chunks are returned unchanged.
 */

import { isCompoundFile, readCompoundFile, type CfbFile } from "./cfb.js";

function inflateChunk(src: Uint8Array, out: Grow): void {
  let i = 0;
  const n = src.length;
  while (i + 1 < n) {
    const flags = src[i]! | (src[i + 1]! << 8);
    i += 2;
    for (let bit = 0; bit < 16 && i < n; bit++) {
      if (flags & (1 << bit)) {
        if (i + 1 >= n) return;
        const b0 = src[i]!;
        const b1 = src[i + 1]!;
        i += 2;
        const length = (b0 & 0x0f) + 1;
        const offset = b1 | ((b0 & 0xf0) << 4);
        if (offset === 0 || offset > out.length) throw new Error("Bad copy token");
        out.copyBack(offset, length);
      } else {
        out.push(src[i]!);
        i += 1;
      }
    }
  }
}

class Grow {
  buf: Uint8Array;
  length = 0;
  constructor(size: number) {
    this.buf = new Uint8Array(Math.max(64, size));
  }
  private ensure(extra: number) {
    if (this.length + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + extra));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  push(b: number) {
    this.ensure(1);
    this.buf[this.length++] = b;
  }
  append(bytes: Uint8Array) {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.length);
    this.length += bytes.length;
  }
  copyBack(offset: number, len: number) {
    this.ensure(len);
    let from = this.length - offset;
    for (let k = 0; k < len; k++) this.buf[this.length++] = this.buf[from++]!;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** True when the bytes walk exactly as a list of FactoryTalk chunks. */
function looksChunked(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 0;
  while (o + 8 <= data.length) {
    const size = dv.getUint32(o, true);
    const stored = dv.getUint16(o + 4, true);
    if (size < 4 || stored > 1 || o + 4 + size > data.length) return false;
    o += 4 + size;
  }
  return o === data.length;
}

/** Unpack one archive stream (returns it unchanged when it isn't chunked). */
export function decodeStream(data: Uint8Array): Uint8Array {
  if (!looksChunked(data)) return data;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Grow(data.length * 4);
  let o = 0;
  try {
    while (o + 8 <= data.length) {
      const size = dv.getUint32(o, true);
      const stored = dv.getUint16(o + 4, true);
      const payload = data.subarray(o + 8, o + 4 + size);
      if (stored === 1) out.append(payload);
      else inflateChunk(payload, out);
      o += 4 + size;
    }
  } catch {
    return data;
  }
  return out.result();
}

/**
 * An archive with long names restored: compound-file names stop at 31
 * characters, so FactoryTalk stores such files as `__MAPPEEn` with the real
 * name in `__MAPPERn` next to it.
 */
export interface Archive {
  /** Every stream path, with real (long) names. */
  paths: string[];
  /** Decoded bytes of a stream by its real path (case-insensitive). */
  read(path: string): Uint8Array | undefined;
}

export function openArchive(bytes: Uint8Array): Archive {
  const cfb: CfbFile = readCompoundFile(bytes);
  const real = new Map<string, string>(); // real path (lower) → stored path
  const paths: string[] = [];
  const streams = cfb.entries.filter((e) => !e.isDir);
  for (const e of streams) {
    if (/__MAPPER\d+$/i.test(e.name)) continue;
    let path = e.path;
    const m = e.name.match(/^__MAPPEE(\d+)$/i);
    if (m) {
      const dir = e.path.slice(0, e.path.length - e.name.length);
      const mapper = cfb.read(`${dir}__MAPPER${m[1]}`);
      const longName = mapper ? utf16Counted(mapper) : undefined;
      if (longName) path = dir + longName;
    }
    real.set(path.toLowerCase(), e.path);
    paths.push(path);
  }
  const cache = new Map<string, Uint8Array>();
  return {
    paths,
    read(path: string) {
      const stored = real.get(path.toLowerCase());
      if (!stored) return undefined;
      const hit = cache.get(stored);
      if (hit) return hit;
      const raw = cfb.read(stored);
      if (!raw) return undefined;
      const decoded = decodeStream(raw);
      cache.set(stored, decoded);
      return decoded;
    },
  };
}

/** Open a decoded stream that is itself a compound file (displays, settings). */
export function openNested(bytes: Uint8Array | undefined): CfbFile | undefined {
  if (!bytes || !isCompoundFile(bytes)) return undefined;
  try {
    return readCompoundFile(bytes);
  } catch {
    return undefined;
  }
}

/** uint32 byte count followed by UTF-16LE text (the `__MAPPER` / AppFile layout). */
export function utf16Counted(bytes: Uint8Array): string | undefined {
  if (bytes.length < 6) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  if (n > bytes.length - 4 || n % 2) return undefined;
  return utf16(bytes, 4, n / 2).replace(/\0+$/, "") || undefined;
}

export function utf16(bytes: Uint8Array, offset: number, chars: number): string {
  let s = "";
  const end = Math.min(bytes.length - 1, offset + chars * 2);
  for (let i = offset; i < end; i += 2) s += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8));
  return s;
}

/** Text of a UTF-16 XML stream (with or without BOM). */
export function utf16Text(bytes: Uint8Array): string {
  const start = bytes[0] === 0xff && bytes[1] === 0xfe ? 2 : 0;
  return utf16(bytes, start, (bytes.length - start) >> 1);
}
