import { useMemo, useState } from "react";
import type { ProjectModel, Routine } from "@core/model/types";
import { toHash, type Location } from "../lib/nav";
import { Icon } from "./Icon";

interface TreeNode {
  id: string;
  label: string;
  detail?: string;
  badge?: string;
  icon: string;
  loc?: Location;
  muted?: boolean;
  children?: TreeNode[];
}

const PLC5_FILE_NAMES: Record<string, string> = {
  O: "Output",
  I: "Input",
  S: "Status",
  B: "Binary",
  T: "Timer",
  C: "Counter",
  R: "Control",
  N: "Integer",
  F: "Float",
  A: "ASCII",
  D: "BCD",
  BT: "Block Transfer",
  MG: "Message",
  PD: "PID",
  SC: "SFC Status",
  ST: "String",
};

const PLC5_FILE_NUM: Record<string, number> = { O: 0, I: 1, S: 2 };

function routineNode(owner: string, kind: "program" | "aoi", r: Routine, main?: string): TreeNode {
  return {
    id: `r:${kind}:${owner}:${r.name}`,
    label: r.name,
    icon: r.type === "st" ? "st" : r.encoded ? "lock" : "ladder",
    badge: main === r.name ? "main" : undefined,
    loc: { view: "routine", ref: { kind, owner, routine: r.name } },
  };
}

function buildTree(project: ProjectModel, issues: number, activeAlarms: number, drawings: number): TreeNode[] {
  const nodes: TreeNode[] = [
    {
      id: "overview",
      label: project.platform === "logix" ? `Controller ${project.name}` : project.name,
      detail: project.controller.processorType,
      icon: "cpu",
      loc: { view: "overview" },
    },
    { id: "assistant", label: "Ask AI", icon: "spark", loc: { view: "assistant" } },
    { id: "troubleshoot", label: "Troubleshoot", icon: "search", loc: { view: "troubleshoot" } },
    ...(project.hmi ?? []).map(
      (h, i): TreeNode => ({
        id: `hmi:${i}`,
        label: project.hmi!.length > 1 ? `Panel ${h.application}` : "Operator panel",
        detail: `${h.screens.length} screens`,
        icon: "panel",
        loc: { view: "hmi" },
        children: [
          { id: `hmi:${i}:alarms`, label: "Alarm messages", icon: "alarm", loc: { view: "hmi", tab: "alarms" }, badge: String(h.messages.length) },
          ...h.screens.map((sc): TreeNode => ({ id: `hmi:${i}:s:${sc.name}`, label: sc.name, icon: "screen", loc: { view: "hmi", screen: sc.name } })),
        ],
      }),
    ),
    ...(project.hmi?.length ? [] : [{ id: "hmi", label: "Operator panel", detail: "add .MER / .APA", icon: "panel", muted: true, loc: { view: "hmi" } } as TreeNode]),
    {
      id: "health",
      label: "Health checks",
      icon: "health",
      loc: { view: "health" },
      ...(issues ? { badge: String(issues) } : {}),
    },
    {
      id: "alarms",
      label: "Alarms & faults",
      icon: "alarm",
      loc: { view: "alarms" },
      ...(activeAlarms ? { badge: `${activeAlarms} on` } : {}),
    },
    { id: "handbook", label: "Alarm handbook", icon: "book", loc: { view: "handbook" } },
    { id: "checklist", label: "Start-up checklist", icon: "check", loc: { view: "checklist" } },
    { id: "iomap", label: "I/O map", icon: "rack", loc: { view: "io" } },
    { id: "connections", label: "Connections", icon: "net", loc: { view: "connections" } },
    { id: "drawings", label: "Drawings", icon: "drawing", loc: { view: "drawings" }, ...(drawings ? { badge: String(drawings) } : {}) },
    { id: "structure", label: "Scan structure", icon: "task", loc: { view: "structure" } },
  ];

  // Panel-only machine (no PLC export yet): just the panel, AI and drawings.
  if (!project.programs.length && project.hmi?.length) {
    const keep = new Set(["assistant", "drawings"]);
    return nodes.filter((n) => keep.has(n.id) || n.id.startsWith("hmi"));
  }

  if (project.platform === "logix") {
    nodes.push({ id: "ctags", label: "Controller Tags", icon: "tags", loc: { view: "tags", scope: "" } });
    const programNode = (name: string): TreeNode | null => {
      const p = project.programs.find((x) => x.name === name);
      if (!p) return null;
      const progTags = project.tags.some((t) => t.scope === p.name);
      return {
        id: `p:${p.name}`,
        label: p.name,
        icon: "folder",
        muted: p.disabled,
        detail: p.disabled ? "disabled" : undefined,
        children: [
          ...(progTags ? [{ id: `pt:${p.name}`, label: "Program Tags", icon: "tags", loc: { view: "tags", scope: p.name } } as TreeNode] : []),
          ...p.routines.map((r) => routineNode(p.name, "program", r, p.mainRoutine)),
        ],
      };
    };
    const scheduled = new Set(project.tasks.flatMap((t) => t.programs));
    nodes.push({
      id: "tasks",
      label: "Tasks",
      icon: "folder",
      children: project.tasks.map((t) => ({
        id: `t:${t.name}`,
        label: t.name,
        icon: "task",
        detail: [t.type?.toLowerCase(), t.rate && t.type !== "CONTINUOUS" ? `${t.rate} ms` : ""].filter(Boolean).join(" · "),
        muted: t.inhibited,
        children: t.programs.map(programNode).filter((x): x is TreeNode => !!x),
      })),
    });
    const unscheduled = project.programs.filter((p) => !scheduled.has(p.name));
    if (unscheduled.length) {
      nodes.push({
        id: "unscheduled",
        label: "Unscheduled Programs",
        icon: "folder",
        children: unscheduled.map((p) => programNode(p.name)!),
      });
    }
    if (project.aois.length) {
      nodes.push({
        id: "aois",
        label: "Add-On Instructions",
        badge: String(project.aois.length),
        icon: "folder",
        children: [...project.aois]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((a) => ({
            id: `a:${a.name}`,
            label: a.name,
            icon: a.encoded ? "lock" : "aoi",
            loc: { view: "aoi", name: a.name },
            children: a.routines.length ? a.routines.map((r) => routineNode(a.name, "aoi", r)) : undefined,
          })),
      });
    }
    if (project.dataTypes.length) {
      nodes.push({
        id: "udts",
        label: "Data Types",
        badge: String(project.dataTypes.length),
        icon: "folder",
        children: [...project.dataTypes]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((d) => ({ id: `d:${d.name}`, label: d.name, icon: "type", loc: { view: "datatype", name: d.name } })),
      });
    }
    if (project.modules.length) {
      nodes.push({ id: "io", label: "I/O Configuration", icon: "rack", loc: { view: "modules" } });
    }
  } else {
    nodes.push({
      id: "programs",
      label: "Program Files",
      icon: "folder",
      children: project.programs.map((p) => ({
        id: `p:${p.name}`,
        label: `${p.number ?? ""} - ${p.name}`,
        icon: "ladder",
        loc: { view: "routine", ref: { kind: "program", owner: p.name, routine: p.routines[0]?.name ?? p.name } },
      })),
    });
    nodes.push({
      id: "datafiles",
      label: "Data Files",
      icon: "folder",
      children: project.dataFiles.map((f) => {
        const num = f.number ?? PLC5_FILE_NUM[f.type];
        return {
          id: `f:${f.name}`,
          label: f.name.includes(":") ? `${f.name} - ${PLC5_FILE_NAMES[f.type] ?? f.type} (slot ${f.number})` : `${f.type}${num ?? ""} - ${PLC5_FILE_NAMES[f.type] ?? f.type}`,
          detail: `${f.elements.length}`,
          icon: "table",
          loc: { view: "datafile", name: f.name },
        };
      }),
    });
  }
  return nodes;
}

function matches(node: TreeNode, q: string): boolean {
  return node.label.toLowerCase().includes(q);
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    const kids = n.children ? filterTree(n.children, q) : [];
    if (matches(n, q) || kids.length) out.push({ ...n, children: kids.length ? kids : n.children && matches(n, q) ? n.children : undefined });
  }
  return out;
}

function pathTo(nodes: TreeNode[], hash: string, trail: string[] = []): string[] | null {
  for (const n of nodes) {
    if (n.loc && toHash(n.loc) === hash) return trail;
    if (n.children) {
      const found = pathTo(n.children, hash, [...trail, n.id]);
      if (found) return found;
    }
  }
  return null;
}

export function Organizer({
  project,
  storageKey,
  location,
  issues,
  activeAlarms,
  drawings,
  onNavigate,
}: {
  project: ProjectModel;
  /** Remembers which folders are open, per machine. */
  storageKey: string;
  location: Location;
  /** Health problems + warnings, shown as a badge. */
  issues: number;
  activeAlarms: number;
  drawings: number;
  onNavigate: (loc: Location) => void;
}) {
  const tree = useMemo(() => buildTree(project, issues, activeAlarms, drawings), [project, issues, activeAlarms, drawings]);
  const [filter, setFilter] = useState("");
  const treeKey = `clt-tree:${storageKey}`;
  const [open, setOpenState] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(treeKey);
      if (saved) return new Set(JSON.parse(saved) as string[]);
    } catch {
      // fall through to defaults
    }
    const s = new Set(["tasks", "programs", "datafiles"]);
    const first = project.tasks[0];
    if (first) s.add(`t:${first.name}`);
    return s;
  });
  const setOpen = (update: (prev: Set<string>) => Set<string>) =>
    setOpenState((prev) => {
      const next = update(prev);
      try {
        localStorage.setItem(treeKey, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });

  const activeHash = toHash(
    location.view === "routine" ? { view: "routine", ref: location.ref } : location.view === "troubleshoot" ? { view: "troubleshoot" } : location,
  );

  // Reveal the active node whenever the location changes (adjusting state during render).
  const [revealed, setRevealed] = useState("");
  if (revealed !== activeHash) {
    setRevealed(activeHash);
    const trail = pathTo(tree, activeHash);
    if (trail?.some((id) => !open.has(id))) setOpen((prev) => new Set([...prev, ...trail]));
  }

  const q = filter.trim().toLowerCase();
  const visible = q ? filterTree(tree, q) : tree;

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((n) => {
      const expanded = q ? true : open.has(n.id);
      const active = n.loc && toHash(n.loc) === activeHash;
      return (
        <li key={n.id}>
          <div
            className={`tree-row ${active ? "active" : ""} ${n.muted ? "muted" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
          >
            {n.children ? (
              <button
                type="button"
                className={`twisty ${expanded ? "open" : ""}`}
                onClick={() => toggle(n.id)}
                aria-label={expanded ? "Collapse" : "Expand"}
              >
                <Icon name="chevron-right" size={14} />
              </button>
            ) : (
              <span className="twisty-spacer" />
            )}
            <button
              type="button"
              className="tree-label"
              onClick={() => (n.loc ? onNavigate(n.loc) : toggle(n.id))}
              title={n.label}
            >
              <span className={`ico ico-${n.icon}`} aria-hidden />
              <span className="tree-text">{n.label}</span>
              {n.badge ? <span className="tree-badge">{n.badge}</span> : null}
              {n.detail ? <span className="tree-detail">{n.detail}</span> : null}
            </button>
          </div>
          {n.children && expanded ? <ul>{render(n.children, depth + 1)}</ul> : null}
        </li>
      );
    });

  return (
    <nav className="organizer" aria-label="Project organizer">
      <div className="pane-head">
        <span className="pane-title">{project.platform === "logix" ? "Controller Organizer" : "Project"}</span>
      </div>
      <div className="organizer-filter">
        <input
          className="input small"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="pane-scroll">
        <ul className="tree">{render(visible, 0)}</ul>
      </div>
    </nav>
  );
}
