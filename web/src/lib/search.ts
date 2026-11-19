import type { ProjectModel } from "@core/model/types";
import { parseClassicAddress } from "@core/logic/refs";
import type { Location, Selection } from "./nav";

export type SearchKind = "routine" | "aoi" | "datatype" | "datafile" | "tag" | "comment" | "module" | "alarm";

export interface SearchItem {
  kind: SearchKind;
  label: string;
  detail?: string;
  haystack: string;
  go: Location;
  select?: Selection;
}

const KIND_ORDER: Record<SearchKind, number> = {
  alarm: 0,
  routine: 0,
  tag: 1,
  aoi: 2,
  datafile: 3,
  datatype: 4,
  module: 5,
  comment: 6,
};

function oneLine(s: string | undefined, max = 110): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function buildSearchIndex(project: ProjectModel): SearchItem[] {
  const items: SearchItem[] = [];
  const mainRoutine = (program: string) => {
    const p = project.programs.find((x) => x.name === program);
    return p?.mainRoutine ?? p?.routines[0]?.name ?? "";
  };

  for (const p of project.programs) {
    for (const r of p.routines) {
      const label = project.platform === "logix" ? `${p.name} / ${r.name}` : `${p.number ?? ""} - ${r.name}`;
      items.push({
        kind: "routine",
        label,
        detail: oneLine(r.description ?? p.description),
        haystack: `${label} ${r.description ?? ""} ${p.description ?? ""}`.toLowerCase(),
        go: { view: "routine", ref: { kind: "program", owner: p.name, routine: r.name } },
      });
      for (const rung of r.rungs) {
        const text = [rung.title, rung.comment].filter(Boolean).join(" ");
        if (!text.trim()) continue;
        items.push({
          kind: "comment",
          label: `Rung ${rung.index} · ${p.name}${project.platform === "logix" ? ` / ${r.name}` : ""}`,
          detail: oneLine(text),
          haystack: text.toLowerCase(),
          go: { view: "routine", ref: { kind: "program", owner: p.name, routine: r.name }, rung: rung.index },
        });
      }
    }
  }

  for (const a of project.aois) {
    items.push({
      kind: "aoi",
      label: a.name,
      detail: oneLine(a.description),
      haystack: `${a.name} ${a.description ?? ""}`.toLowerCase(),
      go: { view: "aoi", name: a.name },
    });
  }

  for (const d of project.dataTypes) {
    items.push({
      kind: "datatype",
      label: d.name,
      detail: oneLine(d.description),
      haystack: `${d.name} ${d.description ?? ""}`.toLowerCase(),
      go: { view: "datatype", name: d.name },
    });
  }

  for (const t of project.tags) {
    const label = t.scope ? `${t.name}` : t.name;
    const where = { kind: "program" as const, owner: t.scope, routine: t.scope ? mainRoutine(t.scope) : "" };
    items.push({
      kind: "tag",
      label,
      detail: oneLine([t.scope ? `Program: ${t.scope}` : "Controller", t.description].filter(Boolean).join(" — ")),
      haystack: `${t.name} ${t.aliasFor ?? ""} ${t.description ?? ""}`.toLowerCase(),
      go: { view: "tags", scope: t.scope },
      select: { kind: "ref", ref: t.name, where },
    });
  }

  if (project.platform !== "logix") {
    const seen = new Set<string>();
    const anyWhere = { kind: "program" as const, owner: project.programs[0]?.name ?? "", routine: "" };
    const fileOf = (addr: string) => {
      const file = parseClassicAddress(addr)?.file;
      return project.dataFiles.find((f) => f.name === file)?.name;
    };
    const symbols = new Map(project.symbols.map((s) => [s.address, s]));
    const add = (address: string) => {
      if (seen.has(address)) return;
      seen.add(address);
      const s = symbols.get(address);
      const file = fileOf(address);
      items.push({
        kind: "tag",
        label: address,
        detail: oneLine([s?.symbol, s?.description].filter(Boolean).join(" — ")),
        haystack: `${address} ${s?.symbol ?? ""} ${s?.description ?? ""}`.toLowerCase(),
        go: file ? { view: "datafile", name: file } : { view: "overview" },
        select: { kind: "ref", ref: address, where: anyWhere },
      });
    };
    for (const e of project.crossReference) add(e.key);
    for (const s of project.symbols) add(s.address);
    for (const f of project.dataFiles) {
      items.push({
        kind: "datafile",
        label: f.name,
        detail: `${f.elements.length} elements`,
        haystack: f.name.toLowerCase(),
        go: { view: "datafile", name: f.name },
      });
    }
  }

  const walk = (mods: ProjectModel["modules"]) => {
    for (const m of mods) {
      items.push({
        kind: "module",
        label: m.name,
        detail: oneLine([m.catalogNumber, m.description].filter(Boolean).join(" — ")),
        haystack: `${m.name} ${m.catalogNumber ?? ""} ${m.description ?? ""} ${m.address ?? ""}`.toLowerCase(),
        go: { view: "modules" },
      });
      walk(m.children);
    }
  };
  walk(project.modules);

  return items;
}

export function searchItems(items: SearchItem[], query: string, limit = 60): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const scored: { item: SearchItem; score: number }[] = [];
  for (const item of items) {
    if (!words.every((w) => item.haystack.includes(w))) continue;
    const label = item.label.toLowerCase();
    let score = label === q ? 0 : label.startsWith(q) ? 1 : label.includes(q) ? 2 : 4;
    score = score * 10 + KIND_ORDER[item.kind];
    scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label, undefined, { numeric: true }));
  return scored.slice(0, limit).map((s) => s.item);
}
