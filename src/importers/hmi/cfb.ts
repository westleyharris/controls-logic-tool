/**
 * Minimal reader for Microsoft compound files (MS-CFB, "OLE structured
 * storage") — the container FactoryTalk View uses for .MER / .APA files and
 * for each display inside them. Read-only, no dependencies.
 */

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE = 0xffffffff;
const END = 0xfffffffe;

export interface CfbEntry {
  /** Full path with "/" separators, no leading slash. */
  path: string;
  name: string;
  size: number;
  isDir: boolean;
}

export interface CfbFile {
  entries: CfbEntry[];
  /** Bytes of a stream by path (case-insensitive), or undefined. */
  read(path: string): Uint8Array | undefined;
}

export function isCompoundFile(bytes: Uint8Array): boolean {
  return bytes.length >= 512 && SIGNATURE.every((b, i) => bytes[i] === b);
}

export function readCompoundFile(bytes: Uint8Array): CfbFile {
  if (!isCompoundFile(bytes)) throw new Error("Not a compound file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => (o + 4 <= bytes.length ? dv.getUint32(o, true) : END);

  const sectorShift = u16(0x1e);
  const miniShift = u16(0x20);
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const fatCount = u32(0x2c);
  const firstDir = u32(0x30);
  const miniCutoff = u32(0x38);
  const firstMiniFat = u32(0x3c);
  let difatNext = u32(0x44);
  const difatCount = u32(0x48);

  const sectorOffset = (i: number) => (i + 1) * sectorSize;

  // FAT sector list: 109 entries in the header, the rest in DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) fatSectors.push(u32(0x4c + 4 * i));
  for (let n = 0; n < difatCount && difatNext !== END && difatNext !== FREE; n++) {
    const base = sectorOffset(difatNext);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per; i++) fatSectors.push(u32(base + 4 * i));
    difatNext = u32(base + 4 * per);
  }
  const fat: number[] = [];
  for (const s of fatSectors.filter((s) => s !== FREE && s !== END).slice(0, fatCount)) {
    const base = sectorOffset(s);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(base + 4 * i));
  }

  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    let s = start;
    while (s !== END && s !== FREE && s < table.length && !seen.has(s)) {
      seen.add(s);
      out.push(s);
      s = table[s]!;
    }
    return out;
  };

  const bigStream = (start: number, size?: number): Uint8Array => {
    const sectors = chain(start, fat);
    const total = size ?? sectors.length * sectorSize;
    const out = new Uint8Array(Math.min(total, sectors.length * sectorSize));
    let o = 0;
    for (const s of sectors) {
      if (o >= out.length) break;
      const from = sectorOffset(s);
      const piece = bytes.subarray(from, Math.min(from + sectorSize, from + out.length - o, bytes.length));
      out.set(piece, o);
      o += piece.length;
    }
    return out;
  };

  // Directory entries (128 bytes each).
  const dir = bigStream(firstDir);
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  interface Raw {
    name: string;
    type: number;
    left: number;
    right: number;
    child: number;
    start: number;
    size: number;
  }
  const raw: Raw[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = ddv.getUint16(off + 64, true);
    let name = "";
    for (let i = 0; i + 1 < Math.min(nameLen, 64) - 1; i += 2) name += String.fromCharCode(ddv.getUint16(off + i, true));
    const sizeLo = ddv.getUint32(off + 120, true);
    const sizeHi = sectorShift === 9 ? 0 : ddv.getUint32(off + 124, true);
    raw.push({
      name,
      type: dir[off + 66]!,
      left: ddv.getUint32(off + 68, true),
      right: ddv.getUint32(off + 72, true),
      child: ddv.getUint32(off + 76, true),
      start: ddv.getUint32(off + 116, true),
      size: sizeHi * 2 ** 32 + sizeLo,
    });
  }
  const root = raw[0];
  if (!root) throw new Error("Compound file has no root entry");

  const ministream = bigStream(root.start, root.size);
  const miniFat: number[] = [];
  for (const s of chain(firstMiniFat, fat)) {
    const base = sectorOffset(s);
    for (let i = 0; i < sectorSize / 4; i++) miniFat.push(u32(base + 4 * i));
  }

  const streamOf = (e: Raw): Uint8Array => {
    if (e.size < miniCutoff) {
      const out = new Uint8Array(e.size);
      let o = 0;
      for (const s of chain(e.start, miniFat)) {
        if (o >= e.size) break;
        const piece = ministream.subarray(s * miniSize, Math.min(s * miniSize + miniSize, s * miniSize + e.size - o));
        out.set(piece, o);
        o += piece.length;
      }
      return out;
    }
    return bigStream(e.start, e.size);
  };

  // Walk the red-black sibling trees into paths.
  const entries: CfbEntry[] = [];
  const byPath = new Map<string, Raw>();
  const visit = (id: number, prefix: string, depth: number) => {
    const stack = [id];
    const seen = new Set<number>();
    while (stack.length) {
      const j = stack.pop()!;
      if (j === FREE || j >= raw.length || seen.has(j) || depth > 32) continue;
      seen.add(j);
      const e = raw[j]!;
      stack.push(e.left, e.right);
      if (e.type !== 1 && e.type !== 2) continue;
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      entries.push({ path, name: e.name, size: e.size, isDir: e.type === 1 });
      byPath.set(path.toLowerCase(), e);
      if (e.type === 1) visit(e.child, path, depth + 1);
    }
  };
  visit(root.child, "", 0);
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    entries,
    read(path: string) {
      const e = byPath.get(path.toLowerCase());
      return e && e.type === 2 ? streamOf(e) : undefined;
    },
  };
}
