import { useMemo, useState } from "react";
import type { ModuleNode, ProjectModel, TagRecord } from "@core/model/types";
import type { ProjectIndex } from "@core/query/index";
import { aoiContext } from "../lib/ai";
import { findAoiCalls } from "../lib/aoiCalls";
import { AskAi } from "./AskAi";
import type { Location, Selection } from "../lib/nav";

/* ------------------------------------ AOI ------------------------------------ */

function ParamTable({ rows, showUsage }: { rows: TagRecord[]; showUsage: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Name</th>
            {showUsage ? <th>Usage</th> : null}
            <th>Type</th>
            {showUsage ? <th>Req</th> : null}
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.name} className={p.visible === false && showUsage ? "dim" : ""}>
              <td className="mono nowrap">{p.name}</td>
              {showUsage ? <td>{p.usage}</td> : null}
              <td className="mono small nowrap">
                {p.dataType}
                {p.dims ? `[${p.dims.join(",")}]` : ""}
              </td>
              {showUsage ? <td>{p.required ? "✓" : ""}</td> : null}
              <td className="desc-cell">{p.description?.replace(/\s*\n\s*/g, " ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AoiView({
  index,
  name,
  onNavigate,
  onSelect,
}: {
  index: ProjectIndex;
  name: string;
  onNavigate: (loc: Location) => void;
  onSelect: (sel: Selection) => void;
}) {
  const aoi = index.aoi(name);
  const [showHelp, setShowHelp] = useState(false);

  const calls = useMemo(() => (aoi ? findAoiCalls(index, aoi.name) : []), [aoi, index]);

  if (!aoi) return <div className="empty-state">AOI {name} not found.</div>;
  const params = aoi.parameters.filter((p) => !/^Enable(In|Out)$/i.test(p.name));

  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">Add-On Instruction{aoi.revision ? ` · rev ${aoi.revision}` : ""}</div>
        <div className="view-title-row">
          <h1 className="view-title mono">{aoi.name}</h1>
          {aoi.encoded ? <span className="chip warn">Source protected</span> : null}
        </div>
        {aoi.description ? <p className="view-desc pre">{aoi.description}</p> : null}
        {aoi.vendor ? <p className="muted small">{aoi.vendor}</p> : null}
      </header>

      {aoi.helpText ? (
        <section className="card">
          <h2 className="card-title">
            Help text
            <button type="button" className="link small" onClick={() => setShowHelp((x) => !x)}>
              {showHelp ? "Hide" : "Show"}
            </button>
          </h2>
          {showHelp ? <p className="pre">{aoi.helpText}</p> : <p className="muted pre clamp-2">{aoi.helpText}</p>}
        </section>
      ) : null}

      <section className="card">
        <h2 className="card-title">Ask AI</h2>
        <AskAi
          cacheKey={`aoi|${aoi.name}`}
          label="Explain this AOI"
          what="this AOI's description, parameters and logic"
          buildContext={() => aoiContext(index, aoi)}
        />
      </section>

      {aoi.routines.length ? (
        <section className="card">
          <h2 className="card-title">Logic</h2>
          <div className="pill-row">
            {aoi.routines.map((r) => (
              <button
                key={r.name}
                type="button"
                className="btn"
                onClick={() => onNavigate({ view: "routine", ref: { kind: "aoi", owner: aoi.name, routine: r.name } })}
              >
                {r.name} <span className="muted">· {r.type === "st" ? "ST" : `${r.rungs.length} rungs`}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="card">
        <h2 className="card-title">Parameters ({params.length})</h2>
        <ParamTable rows={params} showUsage />
      </section>

      {aoi.localTags.length ? (
        <section className="card">
          <h2 className="card-title">Local tags ({aoi.localTags.length})</h2>
          <ParamTable rows={aoi.localTags} showUsage={false} />
        </section>
      ) : null}

      <section className="card">
        <h2 className="card-title">Called from ({calls.length})</h2>
        {calls.length === 0 ? (
          <p className="muted">Not called anywhere in the logic.</p>
        ) : (
          <ul className="hits">
            {calls.slice(0, 300).map((c, i) => (
              <li key={i}>
                <div className="call-row">
                  <button
                    type="button"
                    className="hit"
                    onClick={() => {
                      onNavigate({ view: "routine", ref: c.where, rung: c.rung });
                      onSelect({ kind: "ref", ref: c.instance, where: c.where, rung: c.rung });
                    }}
                  >
                    <span className="hit-addr mono">{c.instance}</span>
                    <span className="hit-loc">
                      {c.where.owner} › {c.where.routine} <span className="muted">· rung {c.rung}</span>
                    </span>
                  </button>
                  {aoi.routines.length ? (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() =>
                        onNavigate({
                          view: "routine",
                          ref: { kind: "aoi", owner: aoi.name, routine: (aoi.routines.find((r) => r.name.toUpperCase() === "LOGIC") ?? aoi.routines[0]!).name },
                          instance: { tag: c.instance, caller: { kind: c.where.kind, owner: c.where.owner } },
                        })
                      }
                    >
                      Logic with values →
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* --------------------------------- Data type --------------------------------- */

export function DataTypeView({ project, name }: { project: ProjectModel; name: string }) {
  const def = project.dataTypes.find((d) => d.name === name);
  if (!def) return <div className="empty-state">Data type {name} not found.</div>;
  const usedBy = project.tags.filter((t) => t.dataType.toUpperCase() === def.name.toUpperCase());
  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">User-defined data type</div>
        <div className="view-title-row">
          <h1 className="view-title mono">{def.name}</h1>
          <span className="view-meta">{def.members.filter((m) => !m.hidden).length} members</span>
        </div>
        {def.description ? <p className="view-desc pre">{def.description}</p> : null}
      </header>
      <section className="card">
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Member</th>
                <th>Type</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {def.members
                .filter((m) => !m.hidden)
                .map((m) => (
                  <tr key={m.name}>
                    <td className="mono nowrap">{m.name}</td>
                    <td className="mono small nowrap">
                      {m.dataType}
                      {m.dims ? `[${m.dims}]` : ""}
                    </td>
                    <td className="desc-cell">{m.description?.replace(/\s*\n\s*/g, " ")}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
      {usedBy.length ? (
        <section className="card">
          <h2 className="card-title">Tags of this type ({usedBy.length})</h2>
          <p className="mono small">{usedBy.map((t) => (t.scope ? `${t.scope}.${t.name}` : t.name)).join(", ")}</p>
        </section>
      ) : null}
    </div>
  );
}

/* --------------------------------- I/O config -------------------------------- */

export function ModulesView({ project }: { project: ProjectModel }) {
  const rows: { m: ModuleNode; depth: number }[] = [];
  const walk = (list: ModuleNode[], depth: number) => {
    for (const m of [...list].sort((a, b) => Number(a.slot ?? 0) - Number(b.slot ?? 0))) {
      rows.push({ m, depth });
      walk(m.children, depth + 1);
    }
  };
  walk(project.modules, 0);
  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">I/O configuration</div>
        <div className="view-title-row">
          <h1 className="view-title">Modules</h1>
          <span className="view-meta">{rows.length} modules</span>
        </div>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Catalog</th>
              <th className="right">Slot</th>
              <th>Address</th>
              <th>Rev</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ m, depth }) => (
              <tr key={`${m.parent}/${m.name}`} className={m.inhibited ? "dim" : ""}>
                <td className="mono nowrap" style={{ paddingLeft: 10 + depth * 18 }}>
                  {depth ? <span className="muted">└ </span> : null}
                  {m.name}
                  {m.inhibited ? <span className="chip warn small">inhibited</span> : null}
                </td>
                <td className="mono small nowrap">{m.catalogNumber}</td>
                <td className="mono right">{m.slot}</td>
                <td className="mono small nowrap">{m.address}</td>
                <td className="mono small">{m.revision}</td>
                <td className="desc-cell">{m.description?.replace(/\s*\n\s*/g, " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
