/**
 * FactoryTalk View Machine Edition (PanelView Plus) applications: read the
 * screens, alarm messages and PLC shortcuts out of a .MER runtime file or an
 * .APA project archive.
 *
 * The display objects are stored in a binary format Rockwell doesn't publish.
 * What's read here is what can be found reliably: each object's name,
 * position, captions, PLC connections and goto target, plus its looks
 * (colours, fonts, outlines, pictures — see style.ts). Anything that doesn't
 * fit is skipped rather than guessed.
 */

import type {
  HmiAccess,
  HmiAddress,
  HmiAlarmMessage,
  HmiAlarmTrigger,
  HmiConnection,
  HmiObject,
  HmiObjectKind,
  HmiProject,
  HmiScreen,
  HmiShortcut,
  HmiState,
} from "../../model/types.js";
import type { CfbFile } from "./cfb.js";
import { openArchive, openNested, utf16, utf16Counted, utf16Text, type Archive } from "./ftview.js";
import { colorHex, displayImages, findLogFont, findPoints, findRectRun, findShade, imageMime, isColor, toBase64, type Shade, type Transform } from "./style.js";

export function parseFactoryTalkMe(bytes: Uint8Array, fileName: string): HmiProject {
  const archive = openArchive(bytes);
  const format = /\.apa$/i.test(fileName) || archive.paths.some((p) => /^HMIServer\//i.test(p)) ? "apa" : "mer";
  const base = archive.paths.some((p) => /^HMIServer\//i.test(p)) ? "HMIServer/" : "";
  const warnings: string[] = [];

  const appFile = archive.read("AppFile");
  const med = archive.paths.find((p) => !p.includes("/") && /\.med$/i.test(p));
  const application =
    (appFile && utf16Counted(appFile)) || (med ? med.replace(/\.med$/i, "") : fileName.replace(/\.[^.]+$/, ""));

  const screenPaths = archive.paths.filter((p) => p.toLowerCase().startsWith(`${base}gfx/`.toLowerCase()) && /\.gfx$/i.test(p));
  const screenNames = screenPaths.map((p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.gfx$/i, ""));
  const known = new Map(screenNames.map((n) => [n.toLowerCase(), n]));
  // Pictures in the archive: name (no extension) → path.
  const imagePaths = new Map<string, string>();
  for (const p of archive.paths) {
    if (!p.toLowerCase().startsWith(`${base}images/`.toLowerCase())) continue;
    const file = p.slice(p.lastIndexOf("/") + 1);
    imagePaths.set(file.replace(/\.[^.]+$/, "").toLowerCase(), p);
  }
  const imageNames = new Map([...imagePaths.keys()].map((k) => [k, k]));

  const screens: HmiScreen[] = [];
  screenPaths.forEach((p, i) => {
    const name = screenNames[i]!;
    try {
      const nested = openNested(archive.read(p));
      if (!nested) {
        warnings.push(`Screen "${name}" isn't in a format this reader knows.`);
        return;
      }
      screens.push(parseScreen(name, nested, known, imageNames));
    } catch (err) {
      warnings.push(`Screen "${name}" couldn't be read (${err instanceof Error ? err.message : String(err)}).`);
    }
  });
  screens.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  fitScreenSizes(screens);

  let triggers: HmiAlarmTrigger[] = [];
  let messages: HmiAlarmMessage[] = [];
  const mal = archive.read(`${base}M_Alarms/MachineAlarms.mal`);
  if (mal) {
    try {
      const nested = openNested(mal);
      const parsed = nested ? parseCompiledAlarms(nested.read("Alarms")) : parseSourceAlarms(mal);
      if (parsed) ({ triggers, messages } = parsed);
      else warnings.push("The alarm setup couldn't be read.");
    } catch {
      warnings.push("The alarm setup couldn't be read.");
    }
  }

  // Pictures the screens use, embedded so the sketches can show them.
  const images: NonNullable<HmiProject["images"]> = {};
  for (const sc of screens) {
    for (const o of sc.objects) {
      if (!o.image || images[o.image]) continue;
      const path = imagePaths.get(o.image);
      const data = path ? archive.read(path) : undefined;
      const mime = data ? imageMime(data) : undefined;
      if (data && mime) images[o.image] = { mime, data: toBase64(data) };
      else delete o.image;
    }
  }
  // Screen background: dark when the text on the screens is mostly light.
  let light = 0;
  let dark = 0;
  for (const sc of screens)
    for (const o of sc.objects) {
      const col = o.text?.color;
      if (!col || o.text?.back) continue;
      const n = Number.parseInt(col.slice(1), 16);
      const lum = 0.299 * ((n >> 16) & 0xff) + 0.587 * ((n >> 8) & 0xff) + 0.114 * (n & 0xff);
      if (lum > 140) light++;
      else dark++;
    }
  if (light + dark > 0) for (const sc of screens) sc.background = light >= dark ? "#000000" : "#c0c0c0";

  const startup = readStartup(archive.read(`${base}Startup/Startup.stp`), screens);
  const shortcuts = readShortcuts(archive);
  // Shortcuts used on screens but missing from the RSLinx setup.
  const used = new Set<string>();
  for (const s of screens) for (const o of s.objects) for (const c of o.connections) for (const r of c.refs) if (r.shortcut) used.add(r.shortcut);
  for (const t of triggers) for (const r of t.refs) if (r.shortcut) used.add(r.shortcut);
  for (const name of used) if (!shortcuts.some((s) => s.name.toLowerCase() === name.toLowerCase())) shortcuts.push({ name });

  const out: HmiProject = { file: fileName, format, application, screens, triggers, messages, shortcuts, warnings };
  if (Object.keys(images).length) out.images = images;
  if (startup) out.startup = startup;
  return out;
}

/** The initial display named in the startup settings. */
function readStartup(bytes: Uint8Array | undefined, screens: HmiScreen[]): string | undefined {
  const nested = openNested(bytes);
  const data = nested?.entries.find((e) => !e.isDir) ? nested.read(nested.entries.find((e) => !e.isDir)!.path) : bytes;
  if (!data) return undefined;
  const has = (name: string) => {
    const enc = new Uint8Array(name.length * 2);
    for (let i = 0; i < name.length; i++) {
      enc[2 * i] = name.charCodeAt(i) & 0xff;
      enc[2 * i + 1] = name.charCodeAt(i) >> 8;
    }
    outer: for (let p = 0; p + enc.length <= data.length; p++) {
      for (let k = 0; k < enc.length; k++) if (data[p + k] !== enc[k]) continue outer;
      return true;
    }
    return false;
  };
  return [...screens].sort((a, b) => b.name.length - a.name.length).find((s) => has(s.name))?.name;
}

/* --------------------------------- screens -------------------------------- */

const STANDARD_SIZES: [number, number][] = [
  [320, 240],
  [640, 480],
  [800, 600],
  [1024, 768],
  [1280, 800],
  [1280, 1024],
  [1366, 768],
  [1920, 1080],
];

function readStringTable(bytes: Uint8Array | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!bytes || bytes.length < 10) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(2, true);
  const poolStart = 10 + 12 * count;
  if (count > 100000 || poolStart > bytes.length) return out;
  const poolChars = (bytes.length - poolStart) >> 1;
  const ids: number[] = [];
  const offs: number[] = [];
  for (let k = 0; k < count; k++) {
    ids.push(dv.getUint32(10 + 12 * k, true));
    offs.push(dv.getUint32(14 + 12 * k, true));
  }
  for (let k = 0; k < count; k++) {
    const start = offs[k]!;
    const end = k + 1 < count ? offs[k + 1]! : poolChars;
    if (start > end || end > poolChars) continue;
    out.set(ids[k]!, utf16(bytes, poolStart + start * 2, end - start));
  }
  return out;
}

const isNameChar = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x20 || c === 0x2d;
const isPrintable = (c: number) => (c >= 0x20 && c < 0x7f) || c === 0x0d || c === 0x0a || c === 0x09 || (c >= 0xa0 && c < 0x3000);

/** UTF-16 text of `chars` code units at `at` if every unit passes `ok`. */
function textAt(b: Uint8Array, at: number, chars: number, ok: (c: number) => boolean): string | undefined {
  if (chars <= 0 || at + chars * 2 > b.length) return undefined;
  let s = "";
  for (let i = 0; i < chars; i++) {
    const c = b[at + 2 * i]! | (b[at + 2 * i + 1]! << 8);
    if (!ok(c)) return undefined;
    s += String.fromCharCode(c);
  }
  return s;
}

interface RawObject {
  name: string;
  rect: [number, number, number, number];
  /** Header transform (scale / offset) applied to the object's own coordinates. */
  transform?: Transform;
  /** Offset of the 6 zero bytes before the name. */
  at: number;
  /** Offset just after the name. */
  bodyStart: number;
}

function findObjects(c: Uint8Array): RawObject[] {
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  const out: RawObject[] = [];
  for (let p = 8; p + 8 < c.length; p++) {
    if (c[p] || c[p + 1] || c[p + 2] || c[p + 3] || c[p + 4] || c[p + 5]) continue;
    const len = c[p + 6]!;
    if (len < 2 || len > 64) continue;
    const name = textAt(c, p + 7, len, isNameChar);
    if (!name || !/^[A-Za-z]/.test(name)) continue;
    const l = dv.getInt16(p - 8, true);
    const t = dv.getInt16(p - 6, true);
    const r = dv.getInt16(p - 4, true);
    const b = dv.getInt16(p - 2, true);
    if (!(l >= -50 && t >= -50 && r > l && b > t && r <= 4000 && b <= 4000)) continue;
    const raw: RawObject = { name, rect: [l, t, r, b], at: p, bodyStart: p + 7 + len * 2 };
    if (p >= 40) {
      const m = [0, 4, 8, 12, 16, 20].map((o) => dv.getFloat32(p - 40 + o, true)) as Transform;
      if (m.every((v) => Number.isFinite(v) && Math.abs(v) < 100000) && Math.abs(m[0]) < 1000 && Math.abs(m[3]) < 1000) raw.transform = m;
    }
    out.push(raw);
    p += 6 + len * 2;
  }
  return out;
}

const ACCESS: Record<number, HmiAccess> = { 0: "animation", 1: "write", 3: "read", 4: "readwrite" };

/** Tag expressions in an object's bytes: uint16 access | uint16 marker | uint16 length | UTF-16 text. */
function findConnections(c: Uint8Array, from: number, to: number): HmiConnection[] {
  const out: HmiConnection[] = [];
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  for (let q = Math.max(from, 4); q + 2 < to; q++) {
    const len = dv.getUint16(q, true);
    if (len < 2 || len > 2000 || q + 2 + len * 2 > to) continue;
    const s = textAt(c, q + 2, len, isPrintable);
    if (!s || !looksLikeExpression(s)) continue;
    const code = dv.getUint16(q - 4, true);
    const access: HmiAccess = ACCESS[code] ?? (s.startsWith("{") ? "animation" : "read");
    // Runtime files keep some expressions twice (source and compiled).
    if (!out.some((c) => c.expr === s && c.access === access)) out.push({ expr: s, access, refs: addressesIn(s) });
    q += 1 + len * 2;
  }
  return out;
}

function looksLikeExpression(s: string): boolean {
  return /\[[^\]]+\]/.test(s) || /^\{.+\}$/.test(s) || /^[A-Za-z_][\w]*\\[\w\\]+$/.test(s) || /^::/.test(s);
}

/** Every `[Shortcut]Address` (and bare HMI tag in braces) inside an expression. */
export function addressesIn(expr: string): HmiAddress[] {
  const out: HmiAddress[] = [];
  const seen = new Set<string>();
  const add = (a: HmiAddress) => {
    const k = `${a.shortcut ?? ""}|${a.address}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(a);
    }
  };
  const re = /(?:::)?\[([^\]]+)\]([A-Za-z_$][\w:.\/$]*(?:\[[^\]]*\][\w:.\/$]*)*)/g;
  for (const m of expr.matchAll(re)) add({ shortcut: m[1]!, address: m[2]!.replace(/[.,;]+$/, "") });
  if (!out.length) {
    for (const m of expr.matchAll(/\{([^{}[\]]+)\}/g)) add({ address: m[1]!.trim() });
    if (!out.length && /^[A-Za-z_][\w]*\\[\w\\]+$/.test(expr)) add({ address: expr });
  }
  return out;
}

/** Captions: references into the display's string table (`ls0000xxxx`), with where each sits. */
function captionIds(c: Uint8Array, objs: RawObject[], table: Map<number, string>): Map<number, { id: number; at: number }[]> {
  const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
  type Hit = { obj: number; id: number; at: number; strong: boolean };
  const hits: Hit[] = [];
  objs.forEach((o, k) => {
    const end = k + 1 < objs.length ? objs[k + 1]!.at : c.length;
    for (let q = o.bodyStart; q + 4 <= end; q++) {
      const v = dv.getUint32(q, true);
      if (!table.has(v) || o.rect.includes(v)) continue;
      // The caption block: 04 01 00, ten bytes of font / colour, then the id.
      const strong = q >= 13 && c[q - 13] === 0x04 && c[q - 12] === 0x01 && c[q - 11] === 0x00;
      if (v < 16 && !strong) continue;
      hits.push({ obj: k, id: v, at: q, strong });
    }
  });
  const owner = new Map<number, Hit>();
  for (const h of hits) {
    const prev = owner.get(h.id);
    if (!prev || (!prev.strong && h.strong)) owner.set(h.id, h);
  }
  const out = new Map<number, { id: number; at: number }[]>();
  for (const h of [...owner.values()].sort((a, b) => a.at - b.at)) {
    const list = out.get(h.obj) ?? [];
    list.push({ id: h.id, at: h.at });
    out.set(h.obj, list);
  }
  return out;
}

/** "/*N:5 {::[PLC]N7:0} NOFILL DP:0*\/" → "{N7:0}" */
export function cleanCaption(s: string): string {
  return s
    .replace(/\/\*[A-Z]:[^{]*\{([^}]*)\}[^*]*\*\//g, (_m, e: string) => `{${e.replace(/::\[[^\]]+\]/g, "").replace(/^\[[^\]]+\]/, "")}}`)
    .replace(/\r\n|\r/g, "\n")
    .trim();
}

const KIND_RULES: [RegExp, HmiObjectKind][] = [
  [/^(numericinputenable|stringinputenable|numericinputcursorpoint|ramp|numericinput)/i, "input"],
  [/(pushbutton|button$|^gotodisplay|^returntodisplay|^closedisplay|selector|^acknowledge|^silence|^reset)/i, "button"],
  [/^(multistateindicator|listindicator|symbolindicator|bargraph|gauge|indicator)/i, "indicator"],
  [/^(numericdisplay|stringdisplay|messagedisplay|localmessagedisplay|timeanddate|trend|recipe)/i, "display"],
  [/^(alarm|diagnostic|information)/i, "alarm"],
  [/^text/i, "text"],
  [/^(panel|polygon|polyline|rectangle|roundedrectangle|line|ellipse|arc|wedge|freeform|image|bitmap)/i, "shape"],
  [/^group/i, "group"],
];

export function objectKind(type: string): HmiObjectKind {
  for (const [re, kind] of KIND_RULES) if (re.test(type)) return kind;
  return "other";
}

function parseScreen(name: string, nested: CfbFile, known: Map<string, string>, imageNames: Map<string, string>): HmiScreen {
  const contents = nested.read("Contents");
  const lsName = nested.entries.find((e) => /^ls00000409$/i.test(e.name))?.name ?? nested.entries.find((e) => /^ls[0-9a-f]{8}$/i.test(e.name))?.name;
  const table = readStringTable(lsName ? nested.read(lsName) : undefined);
  if (!contents) return { name, width: 640, height: 480, objects: [] };
  const pictures = displayImages(nested.read("CacheTables"), imageNames);
  const dv = new DataView(contents.buffer, contents.byteOffset, contents.byteLength);

  const raw = findObjects(contents);
  const captions = captionIds(contents, raw, table);
  const objects: HmiObject[] = raw.map((o, k) => {
    const end = k + 1 < raw.length ? raw[k + 1]!.at : contents.length;
    const type = o.name.replace(/\d+$/, "") || o.name;
    const anchors = captions.get(k) ?? [];
    const texts = anchors.map((a) => table.get(a.id) ?? "");
    const connections = findConnections(contents, o.bodyStart, end);
    // Values embedded in captions ("{N7:0}") are read from the PLC too.
    for (const t of texts) {
      for (const m of t.matchAll(/\/\*[A-Z]:[^{]*\{([^}]*)\}/g)) {
        const expr = m[1]!;
        if (!connections.some((c) => c.expr === expr)) connections.push({ expr, access: "read", refs: addressesIn(expr) });
      }
    }
    const cleaned = [...new Set(texts.map(cleanCaption))].filter((t) => t && t !== "Error");
    const obj: HmiObject = { name: o.name, type, kind: objectKind(type), rect: o.rect, captions: cleaned, connections };
    const target = gotoTarget(contents, o.bodyStart, end, known);
    if (target) obj.goto = target;
    try {
      readLook(obj, contents, dv, o.bodyStart, end, anchors, table, pictures, o.transform);
    } catch {
      // Looks are a bonus: keep the object without them.
    }
    return obj;
  });

  // Content size for now; fitScreenSizes() settles it once every screen is read.
  const maxR = Math.max(0, ...objects.map((o) => o.rect?.[2] ?? 0));
  const maxB = Math.max(0, ...objects.map((o) => o.rect?.[3] ?? 0));
  const minL = Math.max(0, Math.min(...objects.map((o) => o.rect?.[0] ?? 0)));
  const minT = Math.max(0, Math.min(...objects.map((o) => o.rect?.[1] ?? 0)));
  return { name, width: Math.max(40, maxR + minL), height: Math.max(30, maxB + minT), objects };
}

/** Colours, states, font, outline and picture of one object (whatever applies). */
function readLook(
  obj: HmiObject,
  c: Uint8Array,
  dv: DataView,
  from: number,
  to: number,
  anchors: { id: number; at: number }[],
  table: Map<number, string>,
  pictures: string[],
  transform?: Transform,
): void {
  const rect = obj.rect!;
  const setShade = (target: HmiObject | HmiState, sh: Shade | undefined) => {
    if (!sh) return;
    target.fill = colorHex(sh.fill);
    target.border = colorHex(sh.base);
    target.highlight = colorHex(sh.highlight);
    target.shadow = colorHex(sh.shadow);
  };

  // Text: colour and background just before a LOGFONT.
  if (/^text/i.test(obj.type)) {
    const f = findLogFont(c, dv, from, to);
    if (f) {
      // -1 = transparent (a white-on-white help text over a dark panel settled this), 0 = solid.
      const solid = dv.getInt32(f.at - 12, true) === 0;
      const fore = dv.getUint32(f.at - 8, true);
      const back = dv.getUint32(f.at - 4, true);
      obj.text = { size: f.height, bold: f.weight >= 600, font: f.face };
      if (isColor(fore)) obj.text.color = colorHex(fore);
      if (solid && isColor(back)) obj.text.back = colorHex(back);
    }
    return;
  }

  // Polygons and lines: points, line colour, fill when solid.
  if (/^(polygon|polyline|line|freeform)/i.test(obj.type)) {
    const p = findPoints(dv, from, to, rect, transform);
    if (p) {
      obj.points = p.points;
      obj.closed = !/^(polyline|line)/i.test(obj.type);
      const solid = dv.getInt32(p.at - 32, true) === 0;
      const line = dv.getUint32(p.at - 28, true);
      const fill = dv.getUint32(p.at - 20, true);
      const width = dv.getUint32(p.at - 8, true);
      if (isColor(line)) obj.border = colorHex(line);
      if (solid && obj.closed && isColor(fill)) obj.fill = colorHex(fill);
      if (width >= 1 && width <= 20) obj.lineWidth = width;
    }
    return;
  }

  const run = findRectRun(dv, from, to, rect);

  // Pictures: an index into the display's picture list.
  if (/^image/i.test(obj.type) && run !== undefined) {
    const index = dv.getUint32(run + 40, true);
    const name = pictures[index];
    if (name) obj.image = name;
    return;
  }

  // Buttons and indicators: one look per caption (state).
  if (anchors.length) {
    const states: HmiState[] = [];
    let prev = from;
    anchors.forEach((a, i) => {
      const state: HmiState = { caption: cleanCaption(table.get(a.id) ?? "") };
      // Multistate indicator records start with the state's value, 56 bytes before the caption.
      const v = a.at >= 56 ? dv.getUint32(a.at - 56, true) : 0xffffffff;
      if (v < 100000 && isColor(dv.getUint32(a.at - 52, true)) && /indicator/i.test(obj.type)) state.value = v;
      else state.value = i;
      setShade(state, findShade(dv, Math.max(prev, a.at - 64), a.at, a.at));
      prev = a.at + 4;
      states.push(state);
    });
    // The last caption is the error state FactoryTalk shows when the tag can't be read.
    if (states.length > 1 && /^error\b/i.test(states[states.length - 1]!.caption)) states.pop();
    if (states.some((s) => s.fill)) obj.states = states;
    return;
  }

  // Panels, displays, entry fields: one look after the rectangle.
  if (run !== undefined) setShade(obj, findShade(dv, run + 16, Math.min(to, run + 16 + 64), run + 16));
}

/**
 * The panel resolution isn't stored per display in a form read here, so take
 * the standard size most screens fill; smaller ones (pop-ups) keep their own.
 */
function fitScreenSizes(screens: HmiScreen[]): void {
  const fits = (s: HmiScreen, [w, h]: [number, number]) => s.width <= w + 16 && s.height <= h + 16;
  const fills = (s: HmiScreen, [w, h]: [number, number]) => s.width >= w * 0.8 && s.height >= h * 0.7;
  let best: [number, number] | undefined;
  let bestCount = 0;
  for (const size of STANDARD_SIZES) {
    const n = screens.filter((s) => fits(s, size) && fills(s, size)).length;
    if (n > bestCount) {
      best = size;
      bestCount = n;
    }
  }
  for (const s of screens) {
    if (best && fits(s, best) && fills(s, best)) [s.width, s.height] = best;
    else {
      const std = STANDARD_SIZES.find((size) => fits(s, size) && fills(s, size));
      if (std) [s.width, s.height] = std;
    }
  }
}

/** A goto button names its target display as a short counted string. */
function gotoTarget(c: Uint8Array, from: number, to: number, known: Map<string, string>): string | undefined {
  for (let q = from; q + 1 < to; q++) {
    const len = c[q]!;
    if (len < 1 || len > 80 || q + 1 + len * 2 > to) continue;
    const s = textAt(c, q + 1, len, isPrintable);
    if (s && known.has(s.toLowerCase())) return known.get(s.toLowerCase());
  }
  return undefined;
}

/* --------------------------------- alarms --------------------------------- */

/** MFC CString: FF FE FF, length (byte, or FF + uint16), UTF-16 text. */
function cstringAt(b: Uint8Array, i: number): { text: string; end: number } | undefined {
  if (b[i] !== 0xff || b[i + 1] !== 0xfe || b[i + 2] !== 0xff) return undefined;
  let n = b[i + 3]!;
  let at = i + 4;
  if (n === 0xff) {
    n = b[at]! | (b[at + 1]! << 8);
    at += 2;
  }
  if (at + n * 2 > b.length) return undefined;
  return { text: utf16(b, at, n), end: at + n * 2 };
}

const PLACEHOLDER = /^\s*(message\s*#?\s*\d+\s*)?not\s+used\s*$|^\s*message\s*#?\s*\d+\s*$/i;

/** Compiled alarm setup (inside a .MER): triggers, then counted message records. */
function parseCompiledAlarms(b: Uint8Array | undefined): { triggers: HmiAlarmTrigger[]; messages: HmiAlarmMessage[] } | undefined {
  if (!b || b.length < 40) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o: number) => (o + 4 <= b.length ? dv.getUint32(o, true) : -1);

  // Find the message count: the spot where N records parse cleanly to the end.
  let start = -1;
  let count = 0;
  for (let p = 0; p + 40 <= b.length && start < 0; p++) {
    const n = u32(p);
    if (n < 1 || n > 20000) continue;
    const len0 = u32(p + 4 + 32);
    if (len0 < 0 || len0 > 4000 || p + 40 + len0 * 2 > b.length) continue;
    let r = p + 4;
    let ok = true;
    for (let k = 0; k < n; k++) {
      const len = u32(r + 32);
      if (len < 0 || len > 4000 || r + 36 + len * 2 > b.length) {
        ok = false;
        break;
      }
      r += 36 + len * 2;
    }
    if (ok && b.length - r < 64) {
      start = p;
      count = n;
    }
  }
  if (start < 0) return undefined;

  const messages: HmiAlarmMessage[] = [];
  let r = start + 4;
  for (let k = 0; k < count; k++) {
    const value = u32(r);
    const trigger = u32(r + 4);
    const len = u32(r + 32);
    const text = utf16(b, r + 36, len).trim();
    r += 36 + len * 2;
    if (text && !PLACEHOLDER.test(text)) messages.push({ value, trigger, text });
  }

  // Triggers: a label CString followed by the tag it watches.
  const triggers: HmiAlarmTrigger[] = [];
  const head = b.subarray(0, start);
  const labels: { text: string; at: number; end: number }[] = [];
  for (let i = 0; i + 4 < head.length; i++) {
    const s = cstringAt(head, i);
    if (s) {
      labels.push({ ...s, at: i });
      i = s.end - 1;
    }
  }
  labels.forEach((l, k) => {
    const next = labels[k + 1]?.at ?? head.length;
    const conn = findConnections(head, l.end, next)[0];
    if (conn && conn.access === "read") {
      triggers.push({ index: triggers.length + 1, label: l.text, expr: conn.expr, refs: conn.refs });
    }
  });
  return { triggers, messages };
}

/** Source alarm setup (inside an .APA): CStrings for triggers and messages. */
function parseSourceAlarms(b: Uint8Array): { triggers: HmiAlarmTrigger[]; messages: HmiAlarmMessage[] } | undefined {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const strings: { text: string; at: number; end: number }[] = [];
  for (let i = 0; i + 4 < b.length; i++) {
    const s = cstringAt(b, i);
    if (s) {
      strings.push({ ...s, at: i });
      i = s.end - 1;
    }
  }
  const triggers: HmiAlarmTrigger[] = [];
  const messages: HmiAlarmMessage[] = [];
  for (let k = 0; k < strings.length; k++) {
    const s = strings[k]!;
    const next = strings[k + 1];
    if (/^\{.*\}$/.test(s.text) && next && next.text.trim() && !/^[{\d]/.test(next.text) && next.text.length < 64) {
      const expr = s.text.slice(1, -1);
      triggers.push({ index: triggers.length + 1, label: next.text.trim(), expr, refs: addressesIn(expr) });
      k++;
      continue;
    }
    // value CString, uint32 message id, text CString, uint32 trigger
    if (/^\d+$/.test(s.text) && next && next.at === s.end + 4) {
      const value = Number(s.text);
      const trigger = next.end + 4 <= b.length ? dv.getUint32(next.end, true) : 0;
      const text = next.text.trim();
      if (trigger <= 1000 && text && !PLACEHOLDER.test(text)) messages.push({ value, trigger, text });
      k++;
    }
  }
  if (!triggers.length && !messages.length) return undefined;
  return { triggers, messages };
}

/* -------------------------------- shortcuts ------------------------------- */

function readShortcuts(archive: Archive): HmiShortcut[] {
  const pick = (re: RegExp) =>
    archive.paths.filter((p) => re.test(p) && !/ME_R_u_n_t_i_m_e/i.test(p)).sort((a, b) => a.length - b.length)[0];
  const shortcutsPath = pick(/RSLinx Enterprise\/Shortcuts\.xml$/i);
  const xml = shortcutsPath ? archive.read(shortcutsPath) : undefined;
  if (!xml) return [];
  const text = utf16Text(xml);
  // The RSLinx Enterprise topology (device names → IP addresses).
  const candidates = [pick(/RSLinx Enterprise\/RSLinxNG\.xml$/i), ...archive.paths.filter((p) => /RSLinx Enterprise\/[^/]+\.xml$/i.test(p))];
  let topology = "";
  for (const p of candidates) {
    const b = p ? archive.read(p) : undefined;
    const t = b ? utf16Text(b) : "";
    if (t.includes("<Topology")) {
      topology = t;
      break;
    }
  }
  const out: HmiShortcut[] = [];
  for (const m of text.matchAll(/<shortcut\s+name="([^"]+)"[\s\S]*?<\/shortcut>/g)) {
    const block = m[0];
    const device = block.match(/<target\b[^>]*\bdevice="([^"]*)"/)?.[1] || block.match(/<test\b[^>]*\bdevice="([^"]*)"/)?.[1] || undefined;
    const sc: HmiShortcut = { name: m[1]! };
    if (device) {
      sc.device = device;
      const leaf = device.split(".").pop()!;
      const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hit = topology.match(new RegExp(`<port\\b[^>]*\\baddress="([^"]+)"[^>]*>\\s*<device\\s+name="${esc}"(?:\\s+type="([^"]*)")?`));
      if (hit) {
        if (/^\d+\.\d+\.\d+\.\d+$/.test(hit[1]!)) sc.address = hit[1]!;
        if (hit[2]) sc.deviceType = hit[2].startsWith("pccc") ? "PLC-5 / SLC 500 (PCCC)" : hit[2].startsWith("cip") ? "Logix (CIP)" : hit[2];
      }
    }
    out.push(sc);
  }
  return out;
}
