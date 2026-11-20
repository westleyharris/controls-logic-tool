import type { RoutineRef } from "@core/model/types";
import type { AoiInstance, Scope } from "@core/query/index";

/** A routine plus, for AOI logic, the instance whose values are shown. */
export type RoutineScope = RoutineRef & { instance?: AoiInstance };

/** What the center pane shows. Mirrored in the URL hash so Back/Forward work. */
export type Location =
  | { view: "overview" }
  | { view: "routine"; ref: RoutineRef; rung?: number; instance?: AoiInstance }
  | { view: "aoi"; name: string }
  | { view: "datatype"; name: string }
  | { view: "tags"; scope: string }
  | { view: "datafile"; name: string }
  | { view: "modules" }
  | { view: "troubleshoot"; ref?: string; where?: Scope }
  | { view: "health" }
  | { view: "structure" }
  | { view: "io" }
  | { view: "alarms" }
  | { view: "assistant" }
  | { view: "connections" }
  | { view: "checklist"; ref?: string; where?: Scope }
  | { view: "handbook" }
  | { view: "drawings"; id?: string; page?: number }
  | { view: "hmi"; tab?: "screens" | "alarms"; screen?: string; object?: string };

/** What the inspector shows. */
export type Selection =
  | { kind: "rung"; where: RoutineScope; rung: number }
  | { kind: "ref"; ref: string; where: RoutineScope; rung?: number };

const enc = encodeURIComponent;

export function toHash(loc: Location): string {
  switch (loc.view) {
    case "overview":
      return "#/overview";
    case "routine": {
      const base = `#/routine/${loc.ref.kind}/${enc(loc.ref.owner)}/${enc(loc.ref.routine)}`;
      const withRung = loc.rung !== undefined ? `${base}/${loc.rung}` : base;
      return loc.instance ? `${withRung}?i=${enc(JSON.stringify(loc.instance))}` : withRung;
    }
    case "aoi":
      return `#/aoi/${enc(loc.name)}`;
    case "datatype":
      return `#/datatype/${enc(loc.name)}`;
    case "tags":
      return `#/tags/${loc.scope ? enc(loc.scope) : "_controller"}`;
    case "datafile":
      return `#/datafile/${enc(loc.name)}`;
    case "modules":
      return "#/modules";
    case "health":
      return "#/health";
    case "structure":
      return "#/structure";
    case "io":
      return "#/io";
    case "alarms":
      return "#/alarms";
    case "assistant":
      return "#/ask";
    case "connections":
      return "#/connections";
    case "handbook":
      return "#/handbook";
    case "checklist":
      return loc.ref
        ? `#/checklist?r=${enc(loc.ref)}${loc.where ? `&w=${enc(JSON.stringify(loc.where))}` : ""}`
        : "#/checklist";
    case "drawings":
      return loc.id ? `#/drawings?a=${enc(loc.id)}&p=${loc.page ?? 1}` : "#/drawings";
    case "hmi": {
      if (loc.tab === "alarms") return "#/hmi/alarms";
      if (!loc.screen) return "#/hmi";
      return `#/hmi/screen/${enc(loc.screen)}${loc.object ? `/${enc(loc.object)}` : ""}`;
    }
    case "troubleshoot":
      return loc.ref
        ? `#/troubleshoot?r=${enc(loc.ref)}${loc.where ? `&w=${enc(JSON.stringify(loc.where))}` : ""}`
        : "#/troubleshoot";
  }
}

export function fromHash(hash: string): Location | null {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").map(decodeURIComponent);
  const params = new URLSearchParams(query);
  const [view, a, b, c, d] = parts;
  switch (view) {
    case "overview":
      return { view: "overview" };
    case "routine":
      if ((a === "program" || a === "aoi") && b !== undefined && c !== undefined) {
        const loc: Location = { view: "routine", ref: { kind: a, owner: b, routine: c } };
        if (d !== undefined && /^\d+$/.test(d)) loc.rung = Number(d);
        const inst = params.get("i");
        if (inst) {
          try {
            loc.instance = JSON.parse(inst) as AoiInstance;
          } catch {
            // ignore a malformed instance
          }
        }
        return loc;
      }
      return null;
    case "aoi":
      return a ? { view: "aoi", name: a } : null;
    case "datatype":
      return a ? { view: "datatype", name: a } : null;
    case "tags":
      return { view: "tags", scope: !a || a === "_controller" ? "" : a };
    case "datafile":
      return a ? { view: "datafile", name: a } : null;
    case "modules":
      return { view: "modules" };
    case "health":
      return { view: "health" };
    case "structure":
      return { view: "structure" };
    case "io":
      return { view: "io" };
    case "alarms":
      return { view: "alarms" };
    case "ask":
      return { view: "assistant" };
    case "connections":
      return { view: "connections" };
    case "handbook":
      return { view: "handbook" };
    case "checklist": {
      const ref = params.get("r");
      if (!ref) return { view: "checklist" };
      let w: Scope | undefined;
      try {
        const raw = params.get("w");
        if (raw) w = JSON.parse(raw) as Scope;
      } catch {
        // ignore
      }
      return w ? { view: "checklist", ref, where: w } : { view: "checklist", ref };
    }
    case "drawings": {
      const id = params.get("a");
      return id ? { view: "drawings", id, page: Number(params.get("p") ?? 1) || 1 } : { view: "drawings" };
    }
    case "hmi":
      if (a === "alarms") return { view: "hmi", tab: "alarms" };
      if (a === "screen" && b) return c ? { view: "hmi", screen: b, object: c } : { view: "hmi", screen: b };
      return { view: "hmi" };
    case "troubleshoot": {
      const ref = params.get("r");
      if (!ref) return { view: "troubleshoot" };
      let w: Scope | undefined;
      try {
        const raw = params.get("w");
        if (raw) w = JSON.parse(raw) as Scope;
      } catch {
        // ignore
      }
      return w ? { view: "troubleshoot", ref, where: w } : { view: "troubleshoot", ref };
    }
    default:
      return null;
  }
}

export function sameRoutine(a: RoutineRef, b: RoutineRef): boolean {
  return a.kind === b.kind && a.owner === b.owner && a.routine === b.routine;
}
