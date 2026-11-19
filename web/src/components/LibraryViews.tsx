import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import type { CommLink } from "@core/logic/connectivity";
import { LIFECYCLE_LABEL, lifecycleOf, lifecycleUrl, type Lifecycle, type PartEntry, type PartKind } from "@core/logic/parts";
import { companiesOf, platformLabel, type MachineInsights, type MachineSummary } from "../lib/machines";
import { buildNetwork, layoutNetwork, saveEndpointLink, type NetEdge, type Network, type Point } from "../lib/network";
import { useKv } from "../lib/kv";
import type { Location, Selection } from "../lib/nav";
import { searchItems, type SearchKind } from "../lib/search";
import type { IndexProgress } from "../lib/useInsights";
import { FilePicker } from "./FilePicker";
import { KIND_LABEL } from "./SearchPalette";
import { Icon } from "./Icon";

export type LibraryTab = "machines" | "search" | "network" | "parts";

export const LIBRARY_TABS: { id: LibraryTab; label: string; short: string; hash: string }[] = [
  { id: "machines", label: "Machines", short: "Machines", hash: "#/" },
  { id: "search", label: "Search all", short: "Search", hash: "#/library/search" },
  { id: "network", label: "Network map", short: "Network", hash: "#/library/network" },
  { id: "parts", label: "Spare parts", short: "Parts", hash: "#/library/parts" },
];

export function libraryTabFromHash(hash: string): LibraryTab {
  const m = hash.match(/^#\/library\/(\w+)/);
  return (LIBRARY_TABS.find((t) => t.id === m?.[1])?.id ?? "machines") as LibraryTab;
}

export function LibraryTabs({ tab, onTab, progress }: { tab: LibraryTab; onTab: (t: LibraryTab) => void; progress: IndexProgress | null }) {
  return (
    <nav className="lib-tabs" aria-label="Library">
      {LIBRARY_TABS.map((t) => (
        <button key={t.id} type="button" className={`lib-tab ${tab === t.id ? "on" : ""}`} onClick={() => onTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
          <span className="tab-full">{t.label}</span>
          <span className="tab-short">{t.short}</span>
        </button>
      ))}
      {progress ? (
        <span className="lib-progress muted small" title={`Reading ${progress.current}`}>
          <span className="spinner small" aria-hidden /> Indexing {progress.done + 1} of {progress.total}…
        </span>
      ) : null}
    </nav>
  );
}

function IndexingNote({ progress, machines, insights }: { progress: IndexProgress | null; machines: MachineSummary[]; insights: Map<string, MachineInsights> }) {
  if (!progress) return null;
  return (
    <div className="notice">
      Reading exports so they can be searched together — {insights.size} of {machines.length} machines ready (now: {progress.current}). Results fill in as each
      one finishes.
    </div>
  );
}

const machineLabel = (m: MachineSummary) => [m.company, m.line].filter(Boolean).join(" › ");

/* --------------------------------- search all -------------------------------- */

type KindFilter = "all" | "alarm" | "tag" | "comment" | "module" | "routine";
const KIND_FILTERS: { id: KindFilter; label: string; kinds?: SearchKind[] }[] = [
  { id: "all", label: "Everything" },
  { id: "alarm", label: "Alarms", kinds: ["alarm"] },
  { id: "tag", label: "Tags & addresses", kinds: ["tag"] },
  { id: "comment", label: "Rung comments", kinds: ["comment"] },
  { id: "module", label: "Hardware", kinds: ["module"] },
  { id: "routine", label: "Routines", kinds: ["routine", "aoi", "datatype", "datafile"] },
];

export function LibrarySearch({
  machines,
  insights,
  progress,
  onOpen,
}: {
  machines: MachineSummary[];
  insights: Map<string, MachineInsights>;
  progress: IndexProgress | null;
  onOpen: (machineId: string, go: Location, select?: Selection) => void;
}) {
  const [q, setQ] = useState(() => sessionStorage.getItem("clt-lib-q") ?? "");
  const [kind, setKind] = useState<KindFilter>("all");
  const [company, setCompany] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const companies = companiesOf(machines);
  useEffect(() => {
    try {
      sessionStorage.setItem("clt-lib-q", q);
    } catch {
      // ignore
    }
  }, [q]);

  const results = useMemo(() => {
    if (q.trim().length < 2) return [];
    const kinds = KIND_FILTERS.find((k) => k.id === kind)?.kinds;
    return machines
      .filter((m) => !company || (m.company?.trim() ?? "") === company)
      .map((m) => {
        const items = insights.get(m.id)?.search ?? [];
        const hits = searchItems(kinds ? items.filter((i) => kinds.includes(i.kind)) : items, q, 300);
        return { machine: m, hits };
      })
      .filter((r) => r.hits.length)
      .sort((a, b) => b.hits.length - a.hits.length);
  }, [q, kind, company, machines, insights]);

  const total = results.reduce((a, r) => a + r.hits.length, 0);

  return (
    <div className="view lib-view">
      <header className="view-head">
        <div className="view-title-row">
          <h1 className="view-title">Search every machine</h1>
          {q.trim().length >= 2 ? <span className="view-meta">{total >= 300 ? "300+" : total} matches in {results.length} machines</span> : null}
        </div>
        <p className="view-desc">
          Find the same alarm, tag, address, comment or module across the whole plant, e.g. <em>low air</em>, <em>1756-ENBT</em> or <em>seamer brake</em>. Pick a
          result to open that machine right there.
        </p>
        <div className="toolbar wrap">
          <input className="input grow" autoFocus placeholder="Search all machines…" value={q} onChange={(e) => setQ(e.target.value)} type="search" enterKeyHint="search" />
          {companies.length > 1 ? (
            <select className="input" value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company">
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="toggles scroll-x">
          {KIND_FILTERS.map((k) => (
            <button key={k.id} type="button" className={`toggle ${kind === k.id ? "on" : ""}`} onClick={() => setKind(k.id)}>
              <span className="toggle-dot" aria-hidden />
              {k.label}
            </button>
          ))}
        </div>
      </header>
      <IndexingNote progress={progress} machines={machines} insights={insights} />
      {q.trim().length >= 2 && !results.length && !progress ? <div className="empty-state">Nothing matches “{q}” in any machine.</div> : null}
      {results.map(({ machine, hits }) => {
        const open = expanded.has(machine.id);
        const shown = open ? hits : hits.slice(0, 8);
        return (
          <section key={machine.id} className="card lib-result">
            <h2 className="card-title">
              <span>
                {machine.name} {machineLabel(machine) ? <span className="muted small">{machineLabel(machine)}</span> : null}
              </span>
              <span className="muted small">
                {hits.length >= 300 ? "300+" : hits.length} · {platformLabel(machine.platform)}
              </span>
            </h2>
            <ul className="lib-hits">
              {shown.map((item, i) => (
                <li key={i}>
                  <button type="button" className="lib-hit" onClick={() => onOpen(machine.id, item.go, item.select)}>
                    <span className={`kind kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                    <span className="mono lib-hit-label">{item.label}</span>
                    {item.detail ? <span className="lib-hit-detail">{item.detail}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
            {hits.length > 8 ? (
              <button
                type="button"
                className="link small"
                onClick={() =>
                  setExpanded((s) => {
                    const n = new Set(s);
                    if (n.has(machine.id)) n.delete(machine.id);
                    else n.add(machine.id);
                    return n;
                  })
                }
              >
                {open ? "Show fewer" : `Show all ${hits.length >= 300 ? "300+" : hits.length}`}
              </button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/* --------------------------------- network map -------------------------------- */

const DIR_TEXT: Record<CommLink["direction"], string> = { send: "sends →", receive: "← reads", both: "↔ both ways", unknown: "? direction not in export" };
const KIND_TEXT: Record<CommLink["kind"], string> = { msg: "MSG", socket: "Socket", produced: "Produced", consumed: "Consumed" };

const NODE_W = 168;
const NODE_H = 46;

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Point where the line from `a` toward `b` leaves a's box. */
function boxExit(a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!dx && !dy) return a;
  const t = Math.min(NODE_W / 2 / Math.abs(dx || 1e-9), NODE_H / 2 / Math.abs(dy || 1e-9));
  return { x: a.x + dx * Math.min(t, 1), y: a.y + dy * Math.min(t, 1) };
}

type Sel = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

function NetworkMap({ net, pos, sel, onSel }: { net: Network; pos: Map<string, Point>; sel: Sel; onSel: (s: Sel) => void }) {
  const bounds = useMemo(() => {
    const xs = [...pos.values()].map((p) => p.x);
    const ys = [...pos.values()].map((p) => p.y);
    const pad = 110;
    const minX = Math.min(...xs, 0) - pad;
    const minY = Math.min(...ys, 0) - pad;
    return { x: minX, y: minY, w: Math.max(...xs, 0) + pad - minX, h: Math.max(...ys, 0) + pad - minY };
  }, [pos]);
  const [view, setView] = useState(bounds);
  useEffect(() => setView(bounds), [bounds]);
  const svgRef = useRef<SVGSVGElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);

  const toSvg = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    const scale = Math.max(view.w / r.width, view.h / r.height);
    const offX = (r.width * scale - view.w) / 2;
    const offY = (r.height * scale - view.h) / 2;
    return { x: view.x - offX + (clientX - r.left) * scale, y: view.y - offY + (clientY - r.top) * scale, scale };
  };
  const zoom = (factor: number, cx: number, cy: number) => {
    const p = toSvg(cx, cy);
    setView((v) => {
      const w = Math.min(Math.max(v.w * factor, 200), bounds.w * 3);
      const f = w / v.w;
      return { x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f, w, h: v.h * f };
    });
  };
  const onWheel = (e: WheelEvent<SVGSVGElement>) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 40 && e.deltaMode === 0 && !e.altKey) {
      // trackpad two-finger scroll pans
      const s = toSvg(0, 0).scale;
      setView((v) => ({ ...v, x: v.x + e.deltaX * s, y: v.y + e.deltaY * s }));
      return;
    }
    zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  };
  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current = false;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const pts = [...pointers.current.entries()];
    if (pts.length === 2) {
      const other = pts.find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 0 && after > 0) zoom(before / after, (e.clientX + other.x) / 2, (e.clientY + other.y) / 2);
    } else {
      const s = toSvg(0, 0).scale;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true;
      setView((v) => ({ ...v, x: v.x - dx * s, y: v.y - dy * s }));
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };
  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
  };
  const click = (s: Sel) => () => {
    if (!moved.current) onSel(s);
  };

  const related = new Set<string>();
  if (sel?.kind === "node") {
    related.add(sel.id);
    for (const e of net.edges) if (e.a === sel.id || e.b === sel.id) related.add(e.id).add(e.a).add(e.b);
  } else if (sel?.kind === "edge") {
    const e = net.edges.find((x) => x.id === sel.id);
    if (e) related.add(e.id).add(e.a).add(e.b);
  }
  const dim = (id: string) => (sel && !related.has(id) ? " dim" : "");

  return (
    <div className="netmap-wrap">
      <svg
        ref={svgRef}
        className="netmap"
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={onWheel}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClick={(e) => {
          if (e.target === e.currentTarget && !moved.current) onSel(null);
        }}
        role="img"
        aria-label="Machine network map"
      >
        <defs>
          <marker id="net-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="net-arrowhead" />
          </marker>
        </defs>
        {net.edges.map((e) => {
          const pa = pos.get(e.a)!;
          const pb = pos.get(e.b)!;
          const s = boxExit(pa, pb);
          const t = boxExit(pb, pa);
          const mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
          const endpoint = e.a.startsWith("e:") || e.b.startsWith("e:");
          return (
            <g key={e.id} className={`net-edge${endpoint ? " to-endpoint" : ""}${sel?.kind === "edge" && sel.id === e.id ? " on" : ""}${dim(e.id)}`} onClick={click({ kind: "edge", id: e.id })}>
              <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} className="net-hit" />
              <line
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                className={`net-line${e.unknownDir && !e.ab && !e.ba ? " unknown" : ""}`}
                {...(e.ab ? { markerEnd: "url(#net-arrow)" } : {})}
                {...(e.ba ? { markerStart: "url(#net-arrow)" } : {})}
              />
              <g transform={`translate(${mid.x} ${mid.y})`}>
                <rect x={-13} y={-10} width={26} height={20} rx={10} className="net-count-bg" />
                <text className="net-count" textAnchor="middle" dy="4">
                  {e.items.length}
                </text>
              </g>
            </g>
          );
        })}
        {net.nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g
              key={n.id}
              className={`net-node ${n.kind}${sel?.kind === "node" && sel.id === n.id ? " on" : ""}${dim(n.id)}`}
              transform={`translate(${p.x - NODE_W / 2} ${p.y - NODE_H / 2})`}
              onClick={click({ kind: "node", id: n.id })}
            >
              <rect width={NODE_W} height={NODE_H} rx={n.kind === "machine" ? 8 : 23} />
              <text x={NODE_W / 2} y={n.sub || n.address ? 19 : 28} textAnchor="middle" className="net-label">
                {clip(n.label, 22)}
              </text>
              {n.sub || n.address ? (
                <text x={NODE_W / 2} y={35} textAnchor="middle" className="net-sub">
                  {clip(n.kind === "machine" ? (n.sub ?? "") : `${n.address ?? ""} · not in library`, 28)}
                </text>
              ) : n.kind === "endpoint" ? (
                <text x={NODE_W / 2} y={40} textAnchor="middle" className="net-sub">
                  not in library
                </text>
              ) : null}
              <title>{[n.label, n.sub, n.address].filter(Boolean).join(" · ")}</title>
            </g>
          );
        })}
      </svg>
      <div className="netmap-controls">
        <button type="button" className="icon-btn" onClick={() => setView((v) => ({ x: v.x + v.w * 0.1, y: v.y + v.h * 0.1, w: v.w * 0.8, h: v.h * 0.8 }))} aria-label="Zoom in">
          <Icon name="plus" />
        </button>
        <button type="button" className="icon-btn" onClick={() => setView((v) => ({ x: v.x - v.w * 0.125, y: v.y - v.h * 0.125, w: v.w * 1.25, h: v.h * 1.25 }))} aria-label="Zoom out">
          <Icon name="minus" />
        </button>
        <button type="button" className="icon-btn" onClick={() => setView(bounds)} aria-label="Fit" title="Fit everything">
          <Icon name="fit" />
        </button>
      </div>
    </div>
  );
}

function LinkRows({ items, machines, onOpen, showFrom }: { items: NetEdge["items"]; machines: Map<string, MachineSummary>; onOpen: (id: string, go: Location) => void; showFrom: boolean }) {
  return (
    <ul className="net-links">
      {items.map((it, i) => {
        const l = it.link;
        const from = machines.get(it.from);
        return (
          <li key={i}>
            <div className="net-link-head">
              <span className={`dir dir-${l.direction}`}>{DIR_TEXT[l.direction]}</span>
              <span className="chip small">{KIND_TEXT[l.kind]}</span>
              <span className="mono">{l.tag}</span>
              {showFrom && from ? <span className="muted small">in {from.name}</span> : null}
            </div>
            <div className="small">
              {l.detail}
              {l.localData && !l.detail.includes(l.localData) ? <span className="muted"> · local {l.localData}</span> : null}
            </div>
            {l.description ? <div className="muted small">{clip(l.description, 160)}</div> : null}
            <div className="small">
              {l.at && from ? (
                <button type="button" className="link" onClick={() => onOpen(it.from, { view: "routine", ref: l.at!.where, rung: l.at!.rung })}>
                  {l.at.where.owner === l.at.where.routine ? l.at.where.owner : `${l.at.where.owner} › ${l.at.where.routine}`} · rung {l.at.rung}
                </button>
              ) : (
                <span className="muted">not used in the logic</span>
              )}
              {it.match === "name" ? <span className="muted"> · matched by name</span> : it.match === "ip" ? <span className="muted"> · matched by IP</span> : it.match === "manual" ? <span className="muted"> · linked by you</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function NetworkView({
  machines,
  insights,
  progress,
  focus,
  onOpen,
  onAddEndpoint,
}: {
  machines: MachineSummary[];
  insights: Map<string, MachineInsights>;
  progress: IndexProgress | null;
  /** Machine id to select first (from a machine's Connections page). */
  focus?: string;
  onOpen: (machineId: string, go: Location) => void;
  onAddEndpoint: (files: File[], preset: { company: string; line: string; name: string; endpoint: string }) => void;
}) {
  const [showLocal, setShowLocal] = useState(false);
  const [showIsolated, setShowIsolated] = useState(false);
  const [company, setCompany] = useState("");
  const [manual] = useKv<string>("links");
  const [sel, setSel] = useState<Sel>(focus ? { kind: "node", id: `m:${focus}` } : null);
  const companies = companiesOf(machines);
  const byId = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines]);

  const net = useMemo(
    () => buildNetwork(machines, insights, manual, { showLocal, showIsolated, ...(company ? { company } : {}) }),
    [machines, insights, manual, showLocal, showIsolated, company],
  );
  const pos = useMemo(() => layoutNetwork(net), [net]);
  const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
  const unknown = net.nodes.filter((n) => n.kind === "endpoint").length;

  const link = (endpoint: string, machineId: string | null) => saveEndpointLink(endpoint, machineId);

  const detail = () => {
    if (!sel) return null;
    if (sel.kind === "edge") {
      const e = net.edges.find((x) => x.id === sel.id);
      if (!e) return null;
      const a = nodeById.get(e.a)!;
      const b = nodeById.get(e.b)!;
      return (
        <>
          <h2 className="card-title">
            {a.label} ↔ {b.label}
          </h2>
          <p className="muted small">{e.items.length} message{e.items.length === 1 ? "" : "s"} / tag link{e.items.length === 1 ? "" : "s"}</p>
          <LinkRows items={e.items} machines={byId} onOpen={onOpen} showFrom />
        </>
      );
    }
    const n = nodeById.get(sel.id);
    if (!n) return null;
    const mine = net.edges.filter((e) => e.a === n.id || e.b === n.id);
    if (n.kind === "machine" && n.machine) {
      const ins = insights.get(n.machine.id);
      return (
        <>
          <h2 className="card-title">{n.label}</h2>
          <p className="muted small">
            {[machineLabel(n.machine), platformLabel(n.machine.platform), n.machine.processor].filter(Boolean).join(" · ")}
            {ins?.comms.ips.length ? <><br />Own IPs: <span className="mono">{ins.comms.ips.join(", ")}</span></> : null}
          </p>
          <button type="button" className="btn small" onClick={() => onOpen(n.machine!.id, { view: "connections" })}>
            Open its connections →
          </button>
          {mine.length === 0 ? <p className="muted small">No messages to or from other machines found in its export.</p> : null}
          {mine.map((e) => {
            const other = nodeById.get(e.a === n.id ? e.b : e.a)!;
            return (
              <div key={e.id} className="net-partner">
                <button type="button" className="link net-partner-name" onClick={() => setSel({ kind: "node", id: other.id })}>
                  {other.label}
                  {other.kind === "endpoint" ? <span className="chip small warn">not in library</span> : null}
                </button>
                <LinkRows items={e.items} machines={byId} onOpen={onOpen} showFrom={false} />
              </div>
            );
          })}
        </>
      );
    }
    // Unknown endpoint: link it to a machine or add it.
    const seen = (n.seenBy ?? []).map((id) => byId.get(id)).filter((m): m is MachineSummary => !!m);
    const near = seen[0];
    return (
      <>
        <h2 className="card-title">{n.label}</h2>
        <p className="muted small">
          {n.address ? (
            <>
              <span className="mono">{n.address}</span> ·{" "}
            </>
          ) : null}
          Not in your library yet. Named from the {seen.length > 1 ? "messages" : "message"} in {seen.map((m) => m.name).join(", ")}.
        </p>
        <div className="net-actions">
          <label className="small">
            This is…{" "}
            <select className="input" value={manual[n.endpoint!] ?? ""} onChange={(e) => link(n.endpoint!, e.target.value || null)}>
              <option value="">— pick a machine —</option>
              {machines
                .filter((m) => !n.seenBy?.includes(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                    {machineLabel(m) ? ` (${machineLabel(m)})` : ""}
                  </option>
                ))}
            </select>
          </label>
          <FilePicker
            className="btn small"
            onFiles={(f) => onAddEndpoint(f, { company: near?.company ?? "", line: near?.line ?? "", name: n.label, endpoint: n.endpoint! })}
            title="Pick this machine's export to add it to the library"
          >
            + Add it to the library
          </FilePicker>
        </div>
        {mine.map((e) => (
          <LinkRows key={e.id} items={e.items} machines={byId} onOpen={onOpen} showFrom />
        ))}
      </>
    );
  };

  const all = net.edges.flatMap((e) => e.items.map((it) => ({ e, it })));

  return (
    <div className="view lib-view">
      <header className="view-head">
        <div className="view-title-row">
          <h1 className="view-title">Who talks to whom</h1>
          <span className="view-meta">
            {net.nodes.filter((n) => n.kind === "machine").length} machines · {unknown} not in library · {all.length} links
          </span>
        </div>
        <p className="view-desc">
          Built from MSG instructions, MESSAGE tags, sockets and produced/consumed tags in each export. Arrows show which way data goes. Dashed boxes are
          partners you haven&apos;t added yet, named from the message. Click one to link it to a machine or add it.
        </p>
        <div className="toolbar wrap">
          {companies.length > 1 ? (
            <select className="input" value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company">
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          ) : null}
          <button type="button" className={`toggle ${showLocal ? "on" : ""}`} onClick={() => setShowLocal((x) => !x)}>
            <span className="toggle-dot" aria-hidden />
            Own I/O &amp; backplane
          </button>
          <button type="button" className={`toggle ${showIsolated ? "on" : ""}`} onClick={() => setShowIsolated((x) => !x)}>
            <span className="toggle-dot" aria-hidden />
            Machines without links
          </button>
        </div>
      </header>
      <IndexingNote progress={progress} machines={machines} insights={insights} />
      {net.nodes.length === 0 ? (
        <div className="empty-state">
          {progress ? "Reading exports…" : "No messages between machines found yet. Add more machines, or turn on “Machines without links”."}
        </div>
      ) : (
        <div className={`net-layout ${sel ? "has-detail" : ""}`}>
          <NetworkMap net={net} pos={pos} sel={sel} onSel={setSel} />
          {sel ? (
            <aside className="card net-detail">
              <button type="button" className="icon-btn net-close" onClick={() => setSel(null)} aria-label="Close">
                <Icon name="x" />
              </button>
              {detail()}
            </aside>
          ) : null}
        </div>
      )}
      {all.length ? (
        <section className="card">
          <h2 className="card-title">Every link</h2>
          <div className="table-wrap">
            <table className="table net-table">
              <thead>
                <tr>
                  <th>Machine</th>
                  <th>Direction</th>
                  <th>Partner</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {all.map(({ e, it }, i) => {
                  const fromId = `m:${it.from}`;
                  const other = nodeById.get(e.a === fromId ? e.b : e.a);
                  return (
                    <tr key={i} className="clickable" onClick={() => setSel({ kind: "edge", id: e.id })}>
                      <td>{byId.get(it.from)?.name}</td>
                      <td className="nowrap">
                        <span className={`dir dir-${it.link.direction}`}>{DIR_TEXT[it.link.direction]}</span>
                      </td>
                      <td>
                        {other?.label}
                        {other?.kind === "endpoint" ? <span className="muted small"> (not in library)</span> : null}
                      </td>
                      <td className="small">
                        <span className="mono">{it.link.tag}</span> — {it.link.detail}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* --------------------------------- spare parts -------------------------------- */

interface PartNote {
  status?: Lifecycle;
  onHand?: number;
  note?: string;
}

interface PartRow {
  base: string;
  kind: PartKind;
  qty: number;
  description?: string;
  uses: { machine: MachineSummary; entries: PartEntry[] }[];
}

const KIND_NAME: Record<PartKind, string> = {
  controller: "Controller",
  chassis: "Chassis / power",
  comm: "Comms",
  io: "I/O",
  drive: "Drive",
  safety: "Safety I/O",
  other: "Other",
};
const STATUS_ORDER: Lifecycle[] = ["discontinued", "phasing-out", "check", "active-mature", "active"];

function csvCell(v: string | number | undefined): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function PartsView({ machines, insights, progress }: { machines: MachineSummary[]; insights: Map<string, MachineInsights>; progress: IndexProgress | null }) {
  const [notes, setNote] = useKv<PartNote>("parts");
  const [q, setQ] = useState("");
  const [company, setCompany] = useState("");
  const [status, setStatus] = useState<Lifecycle | "">("");
  const [kind, setKind] = useState<PartKind | "">("");
  const [openRow, setOpenRow] = useState<string | null>(null);
  const companies = companiesOf(machines);

  const saveNote = (base: string, patch: PartNote) => {
    const next: PartNote = { ...notes[base], ...patch };
    for (const k of Object.keys(next) as (keyof PartNote)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    setNote(base, Object.keys(next).length ? next : null);
  };

  const rows = useMemo(() => {
    const map = new Map<string, PartRow>();
    for (const m of machines) {
      if (company && (m.company?.trim() ?? "") !== company) continue;
      for (const p of insights.get(m.id)?.parts ?? []) {
        let row = map.get(p.base);
        if (!row) {
          row = { base: p.base, kind: p.kind, qty: 0, uses: [] };
          map.set(p.base, row);
        }
        row.qty++;
        if (!row.description && p.description && p.kind !== "io") row.description = p.description;
        let use = row.uses.find((u) => u.machine.id === m.id);
        if (!use) row.uses.push((use = { machine: m, entries: [] }));
        use.entries.push(p);
      }
    }
    return [...map.values()];
  }, [machines, insights, company]);

  const statusOf = (base: string) => notes[base]?.status ?? lifecycleOf(base).status;
  const filtered = rows
    .filter((r) => (!status || statusOf(r.base) === status) && (!kind || r.kind === kind))
    .filter((r) => {
      const t = q.trim().toLowerCase();
      return !t || r.base.toLowerCase().includes(t) || r.description?.toLowerCase().includes(t) || r.uses.some((u) => u.machine.name.toLowerCase().includes(t));
    })
    .sort((a, b) => STATUS_ORDER.indexOf(statusOf(a.base)) - STATUS_ORDER.indexOf(statusOf(b.base)) || b.qty - a.qty || a.base.localeCompare(b.base));

  const totals = STATUS_ORDER.map((s) => {
    const rs = rows.filter((r) => statusOf(r.base) === s);
    return { s, parts: rs.length, units: rs.reduce((a, r) => a + r.qty, 0) };
  });
  const atRiskControllers = rows.filter((r) => r.kind === "controller" && ["discontinued", "phasing-out"].includes(statusOf(r.base)));

  const exportCsv = () => {
    const head = ["Catalog", "Type", "Lifecycle", "Lifecycle note", "Installed", "On hand", "Machines", "Locations", "Your note"];
    const lines = [head.join(",")];
    for (const r of filtered) {
      const lc = lifecycleOf(r.base);
      lines.push(
        [
          r.base,
          KIND_NAME[r.kind],
          LIFECYCLE_LABEL[statusOf(r.base)],
          notes[r.base]?.status ? "set by you" : lc.note,
          r.qty,
          notes[r.base]?.onHand ?? "",
          r.uses.map((u) => `${u.machine.name} (${u.entries.length})`).join("; "),
          r.uses.map((u) => `${u.machine.name}: ${u.entries.map((e) => e.location).join(" / ")}`).join("; "),
          notes[r.base]?.note ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `spare-parts-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="view lib-view parts-view">
      <header className="view-head">
        <div className="view-title-row">
          <h1 className="view-title">Spare parts &amp; obsolescence</h1>
          <span className="view-meta">
            {rows.length} part numbers · {rows.reduce((a, r) => a + r.qty, 0)} installed
          </span>
        </div>
        <p className="view-desc">
          Hardware from each export&apos;s I/O configuration, counted across machines. Lifecycle is a family-level rule of thumb. Statuses change, so confirm on
          Rockwell&apos;s site (link on each row) before buying or planning. PLC-5 exports don&apos;t include the 1771 I/O, only the processor.
        </p>
        <div className="parts-totals">
          {totals
            .filter((t) => t.parts)
            .map((t) => (
              <button key={t.s} type="button" className={`parts-total lc-${t.s} ${status === t.s ? "on" : ""}`} onClick={() => setStatus(status === t.s ? "" : t.s)}>
                <strong>{t.parts}</strong>
                <span>{LIFECYCLE_LABEL[t.s]}</span>
                <span className="muted small">{t.units} installed</span>
              </button>
            ))}
        </div>
        {atRiskControllers.length ? (
          <div className="notice warn-notice">
            <strong>Controllers to plan for:</strong>{" "}
            {atRiskControllers.map((r) => `${r.base} (${r.uses.map((u) => u.machine.name).join(", ")})`).join("; ")}
          </div>
        ) : null}
        <div className="toolbar wrap no-print">
          <input className="input grow" placeholder="Filter by catalog, description or machine…" value={q} onChange={(e) => setQ(e.target.value)} />
          {companies.length > 1 ? (
            <select className="input" value={company} onChange={(e) => setCompany(e.target.value)} aria-label="Company">
              <option value="">All companies</option>
              {companies.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          ) : null}
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as PartKind | "")} aria-label="Type">
            <option value="">All types</option>
            {(Object.keys(KIND_NAME) as PartKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_NAME[k]}
              </option>
            ))}
          </select>
          <button type="button" className="btn" onClick={exportCsv}>
            Export CSV
          </button>
          <button type="button" className="btn ghost" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </header>
      <IndexingNote progress={progress} machines={machines} insights={insights} />
      <div className="table-wrap">
        <table className="table parts-table">
          <thead>
            <tr>
              <th>Catalog</th>
              <th>Lifecycle</th>
              <th className="num">Installed</th>
              <th className="num">On hand</th>
              <th>Used in</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const lc = lifecycleOf(r.base);
              const st = statusOf(r.base);
              const open = openRow === r.base;
              const onHand = notes[r.base]?.onHand;
              return (
                <tr key={r.base} className={open ? "open" : ""}>
                  <td className="parts-cat-cell">
                    <button type="button" className="link mono parts-cat" onClick={() => setOpenRow(open ? null : r.base)} aria-expanded={open}>
                      {r.base}
                    </button>
                    <div className="muted small">
                      {KIND_NAME[r.kind]}
                      {r.description ? ` · ${clip(r.description, 60)}` : ""}
                    </div>
                    {open ? (
                      <div className="parts-where small">
                        {r.uses.map((u) => (
                          <div key={u.machine.id}>
                            <strong>{u.machine.name}</strong>: {u.entries.map((e) => `${e.location}${e.name && !e.location.includes(e.name) ? ` (${e.name})` : ""}`).join(", ")}
                          </div>
                        ))}
                        <label className="parts-note">
                          Note{" "}
                          <input className="input" defaultValue={notes[r.base]?.note ?? ""} placeholder="Supplier, shelf, replacement…" onBlur={(e) => saveNote(r.base, { note: e.target.value })} />
                        </label>
                      </div>
                    ) : notes[r.base]?.note ? (
                      <div className="small part-note-line">
                        <Icon name="note" size={13} /> {notes[r.base]!.note}
                      </div>
                    ) : null}
                  </td>
                  <td className="parts-lc">
                    <select
                      className={`lc-select lc-${st}`}
                      value={notes[r.base]?.status ?? ""}
                      onChange={(e) => saveNote(r.base, { status: (e.target.value || undefined) as Lifecycle | undefined })}
                      title={notes[r.base]?.status ? "Set by you" : lc.note}
                      aria-label={`Lifecycle of ${r.base}`}
                    >
                      <option value="">{LIFECYCLE_LABEL[lc.status]} (rule)</option>
                      {STATUS_ORDER.map((s) => (
                        <option key={s} value={s}>
                          {LIFECYCLE_LABEL[s]}
                        </option>
                      ))}
                    </select>
                    <div className="muted small lc-note">
                      {notes[r.base]?.status ? "Set by you." : lc.note}{" "}
                      <a href={lifecycleUrl(r.base)} target="_blank" rel="noreferrer" className="no-print">
                        Verify <Icon name="external" size={12} />
                      </a>
                    </div>
                  </td>
                  <td className="num parts-qty" data-label="Installed">
                    {r.qty}
                  </td>
                  <td className="num parts-onhand" data-label="On hand">
                    <input
                      className={`input onhand ${onHand === 0 && ["discontinued", "phasing-out"].includes(st) ? "low" : ""}`}
                      type="number"
                      min={0}
                      inputMode="numeric"
                      value={onHand ?? ""}
                      placeholder="—"
                      onChange={(e) => saveNote(r.base, e.target.value === "" ? { onHand: undefined } : { onHand: Math.max(0, Number(e.target.value)) })}
                      aria-label={`Spares on hand of ${r.base}`}
                    />
                  </td>
                  <td className="small parts-uses" data-label="Used in">
                    {r.uses.map((u) => `${u.machine.name}${u.entries.length > 1 ? ` ×${u.entries.length}` : ""}`).join(", ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!filtered.length && !progress ? <div className="empty-state">No parts match.</div> : null}
    </div>
  );
}
