/**
 * Hardware in a machine (from the export's I/O configuration) and a
 * rule-of-thumb lifecycle hint per catalog family. Rockwell changes lifecycle
 * status over time and per catalog number, so every hint says "verify".
 */

import type { ModuleNode, ProjectModel } from "../model/types.js";

export type PartKind = "controller" | "chassis" | "comm" | "io" | "drive" | "safety" | "other";

export interface PartEntry {
  /** Catalog number as configured, e.g. "1756-ENBT/A". */
  catalog: string;
  /** Catalog without the series letter, e.g. "1756-ENBT" — what you order. */
  base: string;
  kind: PartKind;
  name: string;
  description?: string;
  /** Where it sits, e.g. "Local slot 3" or "Rack 1, slot 4". */
  location: string;
  revision?: string;
}

const SKIP = /^(DPI|DSI)-DRIVE-PERIPHERAL|^\$NoName$/i;

export function baseCatalog(catalog: string): string {
  return catalog
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\/[A-Z]$/i, "")
    .toUpperCase()
    // SLC processor types carry the series letter: 1747-L552C → 1747-L552.
    .replace(/^(1747-L5\d\d)[A-Z]$/, "$1");
}

export function partKind(catalog: string): PartKind {
  const c = baseCatalog(catalog);
  if (/^(1756|1769|1768|5069|1785|1747)-L\d|^1763-L|^1766-L|^1764-LSP|^1762-L|^1761-L|^PLC5|^2080-L/.test(c)) return "controller";
  if (/^(1734|1732|1791|1756)-(IB|OB|IF|IE|OF)\d+S\b/.test(c)) return "safety";
  if (/^1746-A\d|^1756-A\d|^1771-A\d|^1769-PA|^1756-PA|^1756-PB|^1746-P\d|^1771-P/.test(c)) return "chassis";
  if (/POWERFLEX|^20[ABFG]|^22[ABCDF]|^25[ABC]|KINETIX|^2097|^2198|^2094|DRIVE/.test(c)) return "drive";
  if (/-(EN\w*|ENBT|ENET|AENT\w*|ACN\w*|CN\w*|DHRIO|DNB|SDN|SCAN|RIO|ASB|SN|MVI\w*|PROSOFT|ETHERNET-MODULE)$|ETHERNET-MODULE|^1747-(SDN|SN|ASB|AENTR)|^1771-(ASB|ACN)/.test(c)) return "comm";
  if (/^(1734|1756|1746|1771|1769|1794|1732|5069|1762|1766)-/.test(c)) return "io";
  return "other";
}

/** "PLC5_20" series "E" → "1785-L20B" (best guess of the processor catalog). */
function plc5Catalog(processorType: string): string {
  const m = processorType.toUpperCase().match(/PLC5_?(\d+)([A-Z]*)/);
  if (!m) return processorType;
  const suffix = m[2] === "E" ? "E" : m[2] === "C" ? "C15" : m[2] === "L" ? "L" : m[2] === "V" ? "V" : "B";
  return `1785-L${m[1]}${suffix}`;
}

export function partsOf(project: ProjectModel): PartEntry[] {
  const out: PartEntry[] = [];
  const push = (catalog: string, name: string, location: string, extra: Partial<PartEntry> = {}) => {
    if (!catalog || SKIP.test(catalog) || SKIP.test(name)) return;
    out.push({ catalog, base: baseCatalog(catalog), kind: partKind(catalog), name, location, ...extra });
  };

  const proc = project.controller.processorType;
  const hasControllerModule = (mods: ModuleNode[]): boolean =>
    mods.some((m) => (m.catalogNumber && partKind(m.catalogNumber) === "controller") || hasControllerModule(m.children));

  if (proc && !hasControllerModule(project.modules)) {
    const catalog = project.platform === "plc5" ? plc5Catalog(proc) : proc;
    push(catalog, project.controller.name || project.name, project.platform === "slc" ? "Rack 1, slot 0" : "Processor", {
      kind: "controller",
      ...(project.controller.series ? { revision: `Series ${project.controller.series}${project.controller.revision ? ` rev ${project.controller.revision}` : ""}` } : {}),
    });
  }

  const walk = (mods: ModuleNode[], parentLabel?: string) => {
    for (const m of mods) {
      const where =
        project.platform === "logix"
          ? m.name === "Local"
            ? "Local chassis"
            : `${m.parent && m.parent !== "Local" ? `${m.parent}` : "Local"}${m.slot !== undefined && m.slot !== "" ? ` slot ${m.slot}` : ""}${m.address ? ` (${m.address})` : ""}`
          : parentLabel
            ? `${parentLabel}${m.slot !== undefined ? `, slot ${m.slot}` : ""}`
            : m.name;
      if (m.catalogNumber) {
        const desc = m.description?.replace(/\s*\n\s*/g, " · ");
        push(m.catalogNumber, m.name, where, {
          ...(desc ? { description: desc } : {}),
          ...(m.revision ? { revision: m.revision } : {}),
        });
      }
      walk(m.children, project.platform === "logix" ? undefined : m.name);
    }
  };
  walk(project.modules);
  return out;
}

/* --------------------------------- lifecycle --------------------------------- */

export type Lifecycle = "discontinued" | "phasing-out" | "active-mature" | "active" | "check";

export const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  discontinued: "Discontinued",
  "phasing-out": "Being phased out",
  "active-mature": "Active mature",
  active: "Active",
  check: "Check",
};

interface Rule {
  test: RegExp;
  status: Lifecycle;
  note: string;
}

/**
 * First match wins. Family-level rules of thumb, not Rockwell's official list —
 * the report always tells you to confirm on Rockwell's lifecycle status page.
 */
const RULES: Rule[] = [
  { test: /^1785-/, status: "discontinued", note: "PLC-5 processors were discontinued in 2017. Plan a migration to ControlLogix." },
  { test: /^1771-/, status: "discontinued", note: "1771 I/O is largely discontinued along with PLC-5. Spares come from the used/refurbished market." },
  { test: /^1746-(IA8|IB8|IN16|IO12DC|OB8|C7)$/, status: "discontinued", note: "Listed by Rockwell as discontinued (SLC 500 I/O)." },
  { test: /^1747-(L531|C10|C11|DU501)$/, status: "discontinued", note: "Listed by Rockwell as discontinued." },
  { test: /^1747-AENTR$/, status: "phasing-out", note: "Rockwell lists a discontinued date of 15 Feb 2027." },
  { test: /^174[67]-/, status: "phasing-out", note: "SLC 500 parts are being discontinued in stages. Rockwell recommends migrating to CompactLogix 5370/5380." },
  { test: /^1761-|^1762-|^1763-/, status: "discontinued", note: "MicroLogix 1000/1200/1100 are discontinued. Micro800 or CompactLogix is the migration path." },
  { test: /^1764-/, status: "phasing-out", note: "MicroLogix 1500: check the exact catalog number. Most of the MicroLogix family is discontinued." },
  { test: /^1766-/, status: "active-mature", note: "MicroLogix 1400 is the last MicroLogix still sold (active mature)." },
  { test: /^1756-L(1|5\d|6\d)/, status: "discontinued", note: "ControlLogix 5550/5560 controllers are discontinued (L6x in 2016)." },
  { test: /^1756-L7/, status: "check", note: "ControlLogix 5570. The 5580 (L8x) is the current family." },
  { test: /^1756-L8/, status: "active", note: "ControlLogix 5580: current family." },
  { test: /^1756-(ENBT|ENET|EWEB)$/, status: "discontinued", note: "1756-ENBT was discontinued 31 Dec 2021. Replace with 1756-EN2T." },
  { test: /^1756-DHRIO$/, status: "check", note: "DH+/RIO bridge: check status before relying on spares." },
  { test: /^1769-L(2|3)\d/, status: "discontinued", note: "CompactLogix 1769-L3x controllers are discontinued. Replace with 5370/5380." },
  { test: /^1734-/, status: "active", note: "POINT I/O." },
  { test: /^1756-(I|O)[A-Z]*\d/, status: "active", note: "ControlLogix I/O." },
  { test: /^1756-(EN2T|EN2TR|EN3TR|EN4TR|EN2F)/, status: "active", note: "Current ControlLogix EtherNet/IP module." },
  { test: /^5069-|^1769-L3\d{2}|^1756-L8/, status: "active", note: "Current family." },
  { test: /POWERFLEX 70|POWERFLEX 700(?!0)|POWERFLEX 40|POWERFLEX 400/, status: "check", note: "Older PowerFlex family. Check status; PowerFlex 520-series / 755 are the usual replacements." },
];

export function lifecycleOf(base: string): { status: Lifecycle; note: string } {
  const c = base.toUpperCase();
  for (const r of RULES) if (r.test.test(c)) return { status: r.status, note: r.note };
  return { status: "check", note: "No rule for this family. Look it up." };
}

/** Rockwell's lifecycle search for one catalog number. */
export function lifecycleUrl(base: string): string {
  return `https://www.rockwellautomation.com/en-us/products/details.${encodeURIComponent(base)}.html`;
}
