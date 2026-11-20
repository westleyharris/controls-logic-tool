/**
 * Looks of FactoryTalk View ME display objects: colours, fonts, shapes and
 * pictures, read from the binary object stream.
 *
 * What's reliable (checked against the sample application):
 * - Shaded fills are stored as a base colour plus a lighter highlight and a
 *   darker shadow kept side by side, so the fill colour of buttons, panels and
 *   indicator states can be told apart from the other colours around it.
 * - Text objects carry a Windows LOGFONT (height, weight, face) with the text
 *   and background colours just before it.
 * - Polygons and lines store a point count and their corner points.
 * - Image objects store an index into the display's picture list.
 * Caption colours of buttons and indicators aren't pinned down yet, so they're
 * chosen for contrast with the fill.
 */

const u32 = (dv: DataView, o: number) => (o >= 0 && o + 4 <= dv.byteLength ? dv.getUint32(o, true) : 0xffffffff);

/** A COLORREF has its top byte clear. */
export const isColor = (v: number) => v >>> 24 === 0;

const channels = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff] as const;

/** COLORREF (0x00BBGGRR) → "#rrggbb". */
export function colorHex(v: number): string {
  return `#${channels(v)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("")}`;
}

const atLeast = (a: number, b: number) => {
  const x = channels(a);
  const y = channels(b);
  return x[0] >= y[0] && x[1] >= y[1] && x[2] >= y[2];
};

export interface Shade {
  /** Where the base colour first appears in the window. */
  at: number;
  base: number;
  highlight: number;
  shadow: number;
  /** The colour stored just before the base: the fill. */
  fill: number;
}

/**
 * Find a shaded colour in [from, to): an adjacent highlight / shadow pair and,
 * on the same 4-byte grid before it, the base colour between them.
 */
export function findShade(dv: DataView, from: number, to: number, align?: number): Shade | undefined {
  for (let q = Math.max(from, 0); q + 8 <= to; q++) {
    // Records are laid out in 4-byte fields counted back from their caption.
    if (align !== undefined && (((align - q) % 4) + 4) % 4 !== 0) continue;
    const hi = u32(dv, q);
    const sh = u32(dv, q + 4);
    if (!isColor(hi) || !isColor(sh) || hi === sh || hi === 0xffffff || sh === 0) continue;
    if (!atLeast(hi, sh)) continue;
    // Base: first matching colour on this grid, from the start of the window.
    for (let b = q - Math.floor((q - from) / 4) * 4; b < q; b += 4) {
      const base = u32(dv, b);
      if (!isColor(base) || base === hi || base === sh || !atLeast(hi, base) || !atLeast(base, sh)) continue;
      const before = b - 4 >= from ? u32(dv, b - 4) : base;
      return { at: b, base, highlight: hi, shadow: sh, fill: isColor(before) ? before : base };
    }
  }
  return undefined;
}

/** Black or white, whichever reads better on `fill`. */
export function contrastText(fill: string | undefined): string {
  if (!fill) return "#000000";
  const n = Number.parseInt(fill.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#000000" : "#ffffff";
}

export interface FontRecord {
  at: number;
  height: number;
  weight: number;
  face: string;
}

/** A LOGFONTA: negative height, zero width/escapement/orientation, weight, …, ASCII face name. */
export function findLogFont(c: Uint8Array, dv: DataView, from: number, to: number): FontRecord | undefined {
  for (let f = from; f + 60 <= to; f++) {
    const h = dv.getInt32(f, true);
    if (h > -4 || h < -300) continue;
    if (dv.getUint32(f + 4, true) || dv.getUint32(f + 8, true) || dv.getUint32(f + 12, true)) continue;
    const weight = dv.getUint32(f + 16, true);
    if (weight < 100 || weight > 900) continue;
    let face = "";
    for (let i = f + 28; i < f + 60 && c[i]; i++) {
      const ch = c[i]!;
      if (ch < 0x20 || ch > 0x7e) {
        face = "";
        break;
      }
      face += String.fromCharCode(ch);
    }
    if (face.length >= 2) return { at: f, height: -h, weight, face };
  }
  return undefined;
}

/** The object's rectangle repeated as four uint32s (panels, displays, images keep one). */
export function findRectRun(dv: DataView, from: number, to: number, rect: [number, number, number, number]): number | undefined {
  for (let q = from; q + 16 <= to; q++) {
    if (u32(dv, q) === rect[0] >>> 0 && u32(dv, q + 4) === rect[1] >>> 0 && u32(dv, q + 8) === rect[2] >>> 0 && u32(dv, q + 12) === rect[3] >>> 0) return q;
  }
  return undefined;
}

/** 2D transform kept in each object's header: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Transform = [number, number, number, number, number, number];

/**
 * uint16 point count then (int16 x, int16 y) pairs in the shape's own
 * coordinates; the object's transform maps them into its rectangle.
 */
export function findPoints(
  dv: DataView,
  from: number,
  to: number,
  rect: [number, number, number, number],
  m: Transform = [1, 0, 0, 1, 0, 0],
): { at: number; points: [number, number][] } | undefined {
  const [l, t, r, b] = rect;
  const pad = 4;
  for (let q = from; q + 2 < to; q++) {
    const n = dv.getUint16(q, true);
    if (n < 2 || n > 500 || q + 2 + n * 4 > to) continue;
    const pts: [number, number][] = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const sx = dv.getInt16(q + 2 + i * 4, true);
      const sy = dv.getInt16(q + 4 + i * 4, true);
      const x = Math.round((m[0] * sx + m[2] * sy + m[4]) * 10) / 10;
      const y = Math.round((m[1] * sx + m[3] * sy + m[5]) * 10) / 10;
      if (x < l - pad || x > r + pad || y < t - pad || y > b + pad) {
        ok = false;
        break;
      }
      pts.push([x, y]);
    }
    // A real outline touches its own bounding box.
    if (ok && pts.some(([x]) => Math.abs(x - l) <= pad) && pts.some(([x]) => Math.abs(x - r) <= pad)) return { at: q, points: pts };
  }
  return undefined;
}

/** Picture names a display uses, in the order its image objects index them. */
export function displayImages(cacheTables: Uint8Array | undefined, known: Map<string, string>): string[] {
  if (!cacheTables) return [];
  const out: string[] = [];
  const b = cacheTables;
  for (let i = 0; i + 4 < b.length; i++) {
    // UTF-16 runs of printable characters.
    let s = "";
    let j = i;
    while (j + 1 < b.length && b[j + 1] === 0 && b[j]! >= 0x20 && b[j]! < 0x7f) {
      s += String.fromCharCode(b[j]!);
      j += 2;
    }
    if (s.length >= 2) {
      const name = known.get(s.toLowerCase());
      if (name) out.push(name);
      i = j;
    }
  }
  return out;
}

/** "image/jpeg" etc. from the first bytes. */
export function imageMime(b: Uint8Array): string | undefined {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return undefined;
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
