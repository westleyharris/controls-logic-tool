import { useMemo, useState } from "react";
import type { SavedValue } from "@core/model/types";
import type { ProjectIndex } from "@core/query/index";
import { formatValue } from "@core/query/index";
import type { AlarmEntry, CallNode, IoGroup, ScanStructure } from "@core/logic/overview";
import type { Location, Selection } from "../lib/nav";
import { Icon } from "./Icon";

type Nav = { onNavigate: (loc: Location) => void; onSelect: (sel: Selection) => void };

export function StateBadge({ value }: { value: SavedValue | boolean | null | undefined }) {
  if (typeof value === "boolean") return <span className={`bool small ${value ? "on" : "off"}`}>{value ? "ON" : "OFF"}</span>;
  if (typeof value === "number") return <span className="chip mono small">{formatValue(value)}</span>;
  return <span className="muted small">—</span>;
}

/* ------------------------------- scan structure ------------------------------ */

function CallTree({ node, depth, onNavigate }: { node: CallNode; depth: number; onNavigate: (loc: Location) => void }) {
  const [open, setOpen] = useState(depth < 1);
  const kids = node.children.length > 0;
  return (
    <li>
      <div className="call-row-line" style={{ paddingLeft: depth * 16 }}>
        {kids ? (
          <button type="button" className={`twisty ${open ? "open" : ""}`} onClick={() => setOpen((x) => !x)} aria-label={open ? "Collapse" : "Expand"}>
            <Icon name="chevron-right" size={14} />
          </button>
        ) : (
          <span className="twisty-spacer" />
        )}
        <button type="button" className="link mono call-label" onClick={() => onNavigate({ view: "routine", ref: node.ref })}>
          {node.label}
        </button>
        <span className="muted small">
          {node.type === "st" ? "Structured Text" : `${node.rungs} rungs`}
          {kids ? ` · calls ${node.children.length}` : ""}
          {node.repeat ? " · already shown above" : ""}
        </span>
      </div>
      {kids && open ? (
        <ul>
          {node.children.map((c, i) => (
            <CallTree key={i} node={c} depth={depth + 1} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function StructureView({ structure, onNavigate }: { structure: ScanStructure; onNavigate: (loc: Location) => void }) {
  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">Scan structure</div>
        <div className="view-title-row">
          <h1 className="view-title">What runs, and in what order</h1>
        </div>
        <p className="view-desc">Each task's programs in scan order, then the routines each one calls with JSR. Expand a routine to see what it calls.</p>
      </header>
      {structure.tasks.map((t) => (
        <section key={t.name} className={`card task-card ${t.inhibited ? "dim" : ""}`}>
          <h2 className="card-title">
            <span>
              {t.name} <span className="muted small">{t.kind}</span>
            </span>
            {t.inhibited ? <span className="chip warn">inhibited</span> : null}
          </h2>
          {t.description ? <p className="muted small task-desc">{t.description}</p> : null}
          {t.programs.map((p) => (
            <div key={p.name} className="program-block">
              {structure.tasks.length && p.name !== p.root?.label ? (
                <div className="program-name">
                  {p.name}
                  {p.description ? <span className="muted small"> — {p.description.split("\n")[0]}</span> : null}
                  {p.disabled ? <span className="chip warn small">disabled</span> : null}
                </div>
              ) : null}
              {p.root ? (
                <ul className="call-tree">
                  <CallTree node={p.root} depth={0} onNavigate={onNavigate} />
                </ul>
              ) : null}
            </div>
          ))}
        </section>
      ))}
      {structure.unreachable.length ? (
        <section className="card">
          <h2 className="card-title">Not reached from any task</h2>
          <p className="muted small">No call path reaches these routines, so they don&apos;t run (unless they&apos;re a controller fault/power-up handler).</p>
          <ul className="plain">
            {structure.unreachable.map((r) => (
              <li key={`${r.owner}|${r.routine}`}>
                <button type="button" className="link mono" onClick={() => onNavigate({ view: "routine", ref: r })}>
                  {r.owner} › {r.routine}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* ---------------------------------- I/O map ---------------------------------- */

export function IoMapView({ groups, isLogix, nav }: { groups: IoGroup[]; isLogix: boolean; nav: Nav }) {
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<"all" | "input" | "output">("all");
  const q = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          points: g.points.filter(
            (p) =>
              (kind === "all" || p.kind === kind) &&
              (!q || p.label.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || g.title.toLowerCase().includes(q)),
          ),
        }))
        .filter((g) => g.points.length),
    [groups, q, kind],
  );
  const total = groups.reduce((a, g) => a + g.points.length, 0);
  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">I/O map</div>
        <div className="view-title-row">
          <h1 className="view-title">
            {isLogix ? "I/O by module / image tag" : groups[0]?.title.startsWith("Slot") ? "I/O by slot" : "I/O by rack and group"}
          </h1>
          <span className="view-meta">{total} points</span>
        </div>
        <p className="view-desc">
          {isLogix
            ? "Alias tags grouped by the module or I/O image they point at, with their saved state. Values of module tags themselves aren't stored in exports."
            : "Every input and output bit that's documented or used in the logic, with its saved state. Click one to see where it's used, or Why? to trace it."}
        </p>
        <div className="toolbar">
          <input className="input" placeholder="Filter by address, tag or description…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="toggles">
            {(["all", "input", "output"] as const).map((k) => (
              <button key={k} type="button" className={`toggle ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                <span className="toggle-dot" aria-hidden />
                {k === "all" ? "All" : k === "input" ? "Inputs" : "Outputs"}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="io-grid">
        {shown.map((g) => (
          <section key={g.title} className="card io-card">
            <h2 className="card-title">
              <span className="mono">{g.title}</span>
              <span className="muted small">{g.points.length}</span>
            </h2>
            {g.subtitle ? <p className="muted small io-sub">{g.subtitle}</p> : null}
            <ul className="io-points">
              {g.points.map((p) => (
                <li key={p.label}>
                  <button type="button" className="io-point" onClick={() => nav.onSelect({ kind: "ref", ref: p.ref, where: p.where })}>
                    <span className={`io-kind ${p.kind === "input" ? "is-in" : "is-out"}`}>{p.kind === "input" ? "IN" : "OUT"}</span>
                    <StateBadge value={p.value} />
                    <span className="mono io-label">{p.label}</span>
                    {p.forced ? <span className="chip danger small">F {p.forced}</span> : null}
                    {!p.usedInLogic ? <span className="chip small">unused</span> : null}
                    <span className="io-desc">{p.description}</span>
                  </button>
                  <button
                    type="button"
                    className="link small io-why"
                    onClick={() => nav.onNavigate({ view: "troubleshoot", ref: p.ref, where: { kind: p.where.kind, owner: p.where.owner } })}
                  >
                    Why?
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {shown.length === 0 ? <div className="empty-state">No I/O points match.</div> : null}
    </div>
  );
}

/* ----------------------------------- alarms ---------------------------------- */

export function AlarmsView({ alarms, index, nav }: { alarms: AlarmEntry[]; index: ProjectIndex; nav: Nav }) {
  const [onlyActive, setOnlyActive] = useState(false);
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = alarms.filter(
    (a) =>
      (!onlyActive || a.active === true) &&
      (!q || a.label.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q) || a.comment?.toLowerCase().includes(q)),
  );
  const active = alarms.filter((a) => a.active === true).length;
  const where = (a: AlarmEntry) =>
    index.isLogix ? `${a.at.where.owner} › ${a.at.where.routine}` : `${index.program(a.at.where.owner)?.number ?? ""} - ${a.at.where.owner}`;
  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">Alarms &amp; faults</div>
        <div className="view-title-row">
          <h1 className="view-title">Alarm and fault bits</h1>
          <span className={`chip ${active ? "danger" : ""}`}>{active} active when saved</span>
          <span className="view-meta">{alarms.length} found</span>
        </div>
        <p className="view-desc">
          Bits the logic sets with OTE/OTL whose name or description mentions an alarm, fault, trip, overload, E-stop… Found by
          wording, so a few may be status bits — and alarms raised only on the HMI won&apos;t appear.
        </p>
        <div className="toolbar">
          <input className="input" placeholder="Filter alarms…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className={`toggle ${onlyActive ? "on" : ""}`} onClick={() => setOnlyActive((x) => !x)}>
            <span className="toggle-dot" aria-hidden />
            Active only
          </button>
        </div>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>State</th>
              <th>Bit</th>
              <th>Description</th>
              <th>Set in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={`${a.label}|${a.at.where.owner}`} className={`clickable ${a.active ? "alarm-active" : ""}`} onClick={() => nav.onSelect({ kind: "ref", ref: a.ref, where: a.where })}>
                <td>
                  <StateBadge value={a.active} />
                </td>
                <td className="mono tag-name">{a.label}</td>
                <td className="desc-cell">
                  {a.description}
                  {a.comment && a.comment !== a.description ? <div className="muted small">{a.comment}</div> : null}
                </td>
                <td className="nowrap small">
                  <button
                    type="button"
                    className="link"
                    onClick={(e) => {
                      e.stopPropagation();
                      nav.onNavigate({ view: "routine", ref: a.at.where, rung: a.at.rung });
                      nav.onSelect({ kind: "ref", ref: a.ref, where: a.where, rung: a.at.rung });
                    }}
                  >
                    {where(a)} · rung {a.at.rung}
                  </button>
                </td>
                <td className="nowrap">
                  <button
                    type="button"
                    className="link small"
                    onClick={(e) => {
                      e.stopPropagation();
                      nav.onNavigate({ view: "troubleshoot", ref: a.ref, where: { kind: a.where.kind, owner: a.where.owner } });
                    }}
                  >
                    Why?
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 ? <div className="empty-state">No alarms match.</div> : null}
    </div>
  );
}
