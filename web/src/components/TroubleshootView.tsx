import { useMemo, useState } from "react";
import type { Blocker } from "@core/logic/evaluate";
import { plc5SnapshotTime } from "@core/logic/health";
import { traceSignal, type TraceWriter } from "@core/logic/trace";
import { formatValue, type ProjectIndex, type Scope } from "@core/query/index";
import { describeBlocker } from "../lib/explain";
import { verdictFor, writerWhere } from "../lib/troubleshoot";
import type { Location, Selection } from "../lib/nav";
import { searchItems, type SearchItem } from "../lib/search";

type Nav = { onNavigate: (loc: Location) => void; onSelect: (sel: Selection) => void };

const strip = (key: string) => key.replace(/^(Program|AOI):[^.]+\./, "");

const EFFECT_LABEL: Record<TraceWriter["effect"], string> = {
  drive: "Turns it ON",
  set: "Latches it ON",
  reset: "Turns it OFF",
  timer: "Runs the timer",
  counter: "Counts",
  value: "Writes a value",
  aoi: "AOI writes it",
  other: "Writes it",
};

function stateBadge(v: unknown) {
  if (typeof v === "boolean") return <span className={`bool small ${v ? "on" : "off"}`}>{v ? "ON" : "OFF"}</span>;
  if (typeof v === "number") return <span className="chip mono">{formatValue(v)}</span>;
  return <span className="chip">no value</span>;
}

/* --------------------------------- verdict --------------------------------- */

/* -------------------------------- tree nodes -------------------------------- */

function BlockerTree({
  blockers,
  index,
  where,
  path,
  depth,
  nav,
}: {
  blockers: Blocker[];
  index: ProjectIndex;
  where: Scope;
  path: string[];
  depth: number;
  nav: Nav;
}) {
  return (
    <ul className="tblockers">
      {blockers.map((b, i) =>
        b.kind === "instr" ? (
          <BlockerRow key={i} blocker={b} index={index} where={where} path={path} depth={depth} nav={nav} />
        ) : (
          <li key={i} className="anyof">
            <span className="muted small">One of these branches must be true:</span>
            {b.branches.map((br, k) => (
              <div key={k} className="anyof-branch">
                <span className="muted small">Branch {k + 1}</span>
                <BlockerTree blockers={br} index={index} where={where} path={path} depth={depth} nav={nav} />
              </div>
            ))}
          </li>
        ),
      )}
    </ul>
  );
}

function BlockerRow({
  blocker,
  index,
  where,
  path,
  depth,
  nav,
}: {
  blocker: Extract<Blocker, { kind: "instr" }>;
  index: ProjectIndex;
  where: Scope;
  path: string[];
  depth: number;
  nav: Nav;
}) {
  const [open, setOpen] = useState(false);
  const d = describeBlocker(blocker.node, blocker.state, index, where);
  const key = d.ref ? index.resolve(d.ref, where).key : undefined;
  const loop = !!key && path.includes(key);
  return (
    <li>
      <div className="tblocker">
        <span className="x" aria-hidden>
          ✕
        </span>
        <span className="tblocker-text">{d.text}</span>
        {d.ref && !loop ? (
          <button type="button" className="btn ghost small" onClick={() => setOpen((x) => !x)}>
            {open ? "Hide" : "Why? ▸"}
          </button>
        ) : loop ? (
          <span className="muted small">(traced above)</span>
        ) : null}
      </div>
      {open && d.ref ? (
        <div className="tnested">
          <TraceNode index={index} refName={d.ref} where={where} path={[...path, key!]} depth={depth + 1} nav={nav} />
        </div>
      ) : null}
    </li>
  );
}

function WriterRow({ w, index, path, depth, nav }: { w: TraceWriter; index: ProjectIndex; path: string[]; depth: number; nav: Nav }) {
  const scope: Scope = { kind: w.where.kind, owner: w.where.owner };
  const open = () => {
    nav.onNavigate({ view: "routine", ref: w.where, rung: w.hit.rung });
    nav.onSelect({ kind: "rung", where: w.where, rung: w.hit.rung });
  };
  return (
    <li className="twriter">
      <div className="twriter-head">
        <span className={`state-dot ${w.energized === true ? "on" : w.energized === false ? "off" : "unknown"}`} aria-hidden />
        <span className="twriter-effect">{EFFECT_LABEL[w.effect]}</span>
        <button type="button" className="link mono" onClick={open}>
          {writerWhere(index, w)}
        </button>
        <span className="muted small">{w.energized === true ? "has power" : w.energized === false ? "no power" : "unknown"}</span>
      </div>
      {w.energized !== true && w.blockers.length ? (
        <BlockerTree blockers={w.blockers} index={index} where={scope} path={path} depth={depth} nav={nav} />
      ) : null}
    </li>
  );
}

export function TraceNode({
  index,
  refName,
  where,
  path,
  depth,
  nav,
}: {
  index: ProjectIndex;
  refName: string;
  where: Scope;
  path: string[];
  depth: number;
  nav: Nav;
}) {
  const t = useMemo(() => traceSignal(index, refName, where), [index, refName, where]);
  const verdict = useMemo(() => verdictFor(index, t), [index, t]);
  const [showAll, setShowAll] = useState(false);
  const info = t.info;
  const thisPath = path.length ? path : [info.key];
  const direct = t.writers.filter((w) => w.direct);
  const indirect = t.writers.filter((w) => !w.direct);
  const others = direct.filter((w) => !verdict.focus.includes(w));

  return (
    <div className={`tnode depth-${Math.min(depth, 4)}`}>
      <div className="tnode-head">
        {stateBadge(info.value)}
        <button
          type="button"
          className="link mono tnode-name"
          onClick={() => nav.onSelect({ kind: "ref", ref: refName, where: { ...where, routine: "" } })}
          title="Show in the inspector"
        >
          {strip(info.key)}
        </button>
        {info.description ? <span className="tnode-desc">{info.description.replace(/\s*\n\s*/g, " ")}</span> : null}
        {t.io ? <span className="chip">{t.io.kind === "input" ? "Input" : "Output"} · {t.io.location}</span> : null}
        {info.forced ? <span className="chip danger">Forced {info.forced.toUpperCase()}</span> : null}
      </div>
      <p className={`verdict ${verdict.tone}`}>{verdict.text}</p>
      {verdict.focus.length ? (
        <ul className="twriters">
          {verdict.focus.slice(0, 20).map((w, i) => (
            <WriterRow key={i} w={w} index={index} path={thisPath} depth={depth} nav={nav} />
          ))}
        </ul>
      ) : null}
      {others.length ? (
        <div className="tmore">
          <button type="button" className="link small" onClick={() => setShowAll((x) => !x)}>
            {showAll ? "Hide" : "Show"} {others.length} other place{others.length === 1 ? "" : "s"} that write it
          </button>
          {showAll ? (
            <ul className="twriters">
              {others.slice(0, 40).map((w, i) => (
                <WriterRow key={i} w={w} index={index} path={thisPath} depth={depth} nav={nav} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {indirect.length ? (
        <details className="tmore">
          <summary className="small muted">
            Also written as part of {strip(info.base)} by {indirect.length} instruction{indirect.length === 1 ? "" : "s"} (whole-structure copies, AOI
            InOut parameters…)
          </summary>
          <ul className="twriters">
            {indirect.slice(0, 40).map((w, i) => (
              <WriterRow key={i} w={{ ...w, blockers: [] }} index={index} path={thisPath} depth={depth} nav={nav} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/* ---------------------------------- page ---------------------------------- */

interface OutputRow {
  ref: string;
  where: Scope & { routine: string };
  label: string;
  description?: string;
  value: unknown;
}

function outputRows(index: ProjectIndex): OutputRow[] {
  const rows: OutputRow[] = [];
  for (const e of index.project.crossReference) {
    const w = e.hits.find((h) => h.access === "write" && h.kind === "program");
    if (!w) continue;
    const scope = { kind: w.kind, owner: w.owner, routine: w.routine };
    if (!index.isLogix) {
      if (!/^O:/.test(e.key)) continue;
    } else {
      if (e.key !== e.base) continue;
      const info = index.resolve(w.address, scope);
      if (!info.aliasFor) continue;
    }
    const info = index.resolve(w.address, scope);
    if (typeof info.value !== "boolean") continue;
    rows.push({ ref: w.address, where: scope, label: strip(e.key), ...(info.description ? { description: info.description.replace(/\s*\n\s*/g, " ") } : {}), value: info.value });
  }
  return rows;
}

export function TroubleshootView({
  index,
  items,
  refName,
  where,
  onNavigate,
  onSelect,
}: {
  index: ProjectIndex;
  items: SearchItem[];
  refName?: string;
  where?: Scope;
  onNavigate: (loc: Location) => void;
  onSelect: (sel: Selection) => void;
}) {
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"all" | "on" | "off">("all");
  const [listFilter, setListFilter] = useState("");
  const tagItems = useMemo(() => items.filter((i) => i.kind === "tag"), [items]);
  const results = useMemo(() => (query.trim() ? searchItems(tagItems, query, 12) : []), [tagItems, query]);
  const outputs = useMemo(() => outputRows(index), [index]);
  const snapshot = plc5SnapshotTime(index);
  const nav: Nav = { onNavigate, onSelect };
  const scope = useMemo<Scope>(() => where ?? { kind: "program", owner: index.project.programs[0]?.name ?? "" }, [where, index]);

  const pickRef = (ref: string, w: Scope) => onNavigate({ view: "troubleshoot", ref, where: { kind: w.kind, owner: w.owner, ...(w.instance ? { instance: w.instance } : {}) } });

  const lf = listFilter.trim().toLowerCase();
  const shownOutputs = outputs.filter(
    (o) =>
      (stateFilter === "all" || (stateFilter === "on") === o.value) &&
      (!lf || o.label.toLowerCase().includes(lf) || o.description?.toLowerCase().includes(lf)),
  );

  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">Troubleshoot</div>
        <div className="view-title-row">
          <h1 className="view-title">Why is it ON / OFF?</h1>
        </div>
        <p className="view-desc">
          Pick a signal. You'll see every rung that writes it, whether each one has power in the saved values, and what's
          blocking it — then follow any blocking condition back with <strong>Why? ▸</strong>.
          {snapshot ? (
            <>
              {" "}
              Values were saved at <strong>{snapshot}</strong> (processor clock).
            </>
          ) : null}
        </p>
        <div className="picker">
          <input
            className="input"
            placeholder="Tag, address or description — e.g. O:011/1, Motor_Run, seamer start…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length ? (
            <ul className="picker-results">
              {results.map((r, i) => (
                <li key={i}>
                  <button
                    type="button"
                    className="palette-item"
                    onClick={() => {
                      setQuery("");
                      if (r.select?.kind === "ref") pickRef(r.select.ref, r.select.where);
                    }}
                  >
                    <span className="kind kind-tag">Tag</span>
                    <span className="palette-label mono">{r.label}</span>
                    {r.detail ? <span className="palette-detail">{r.detail}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>

      {refName ? (
        <section className="card trace-card">
          <div className="trace-actions">
            <button type="button" className="btn ghost small" onClick={() => onNavigate({ view: "troubleshoot" })}>
              ← All outputs
            </button>
          </div>
          <TraceNode key={`${refName}|${JSON.stringify(scope)}`} index={index} refName={refName} where={scope} path={[]} depth={0} nav={nav} />
        </section>
      ) : (
        <section className="card">
          <h2 className="card-title">
            {index.isLogix ? "Output aliases written by the logic" : "Physical outputs written by the logic"}
            <span className="muted small">{shownOutputs.length}</span>
          </h2>
          <div className="toolbar">
            <input className="input" placeholder="Filter outputs…" value={listFilter} onChange={(e) => setListFilter(e.target.value)} />
            <div className="toggles">
              {(["all", "off", "on"] as const).map((s) => (
                <button key={s} type="button" className={`toggle ${stateFilter === s ? "on" : ""}`} onClick={() => setStateFilter(s)}>
                  <span className="toggle-dot" aria-hidden />
                  {s === "all" ? "All" : s === "on" ? "ON" : "OFF"}
                </button>
              ))}
            </div>
          </div>
          {shownOutputs.length === 0 ? (
            <p className="muted">No outputs match.</p>
          ) : (
            <div className="table-wrap">
              <table className="table compact">
                <tbody>
                  {shownOutputs.slice(0, 400).map((o) => (
                    <tr key={o.label} className="clickable" onClick={() => pickRef(o.ref, o.where)}>
                      <td className="nowrap">{stateBadge(o.value)}</td>
                      <td className="mono tag-name">{o.label}</td>
                      <td className="desc-cell">{o.description}</td>
                      <td className="right nowrap">
                        <span className="link small">Why? ▸</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
