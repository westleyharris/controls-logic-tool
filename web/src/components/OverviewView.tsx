import type { ProjectModel } from "@core/model/types";
import type { ProjectIndex } from "@core/query/index";
import { plc5SnapshotTime, type HealthFinding } from "@core/logic/health";
import type { AlarmEntry, CallNode, IoGroup, ScanStructure } from "@core/logic/overview";
import type { Location, Selection } from "../lib/nav";
import { StateBadge } from "./InsightViews";

function fmtSize(chars: number): string {
  if (chars > 1024 * 1024) return `${(chars / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(chars / 1024))} KB`;
}

function countRoutines(structure: ScanStructure): number {
  let n = 0;
  const walk = (node: CallNode | undefined) => {
    if (!node || node.repeat) return;
    n += 1;
    node.children.forEach(walk);
  };
  for (const t of structure.tasks) for (const p of t.programs) walk(p.root);
  return n;
}

export function OverviewView({
  project,
  index,
  health,
  structure,
  io,
  alarms,
  onNavigate,
  onSelect,
}: {
  project: ProjectModel;
  index: ProjectIndex;
  health: HealthFinding[];
  structure: ScanStructure;
  io: IoGroup[];
  alarms: AlarmEntry[];
  onNavigate: (loc: Location) => void;
  onSelect: (sel: Selection) => void;
}) {
  const c = project.controller;
  const s = project.stats;
  const logix = project.platform === "logix";
  const snapshot = plc5SnapshotTime(index);
  const attention = health.filter((f) => f.severity !== "info");
  const activeAlarms = alarms.filter((a) => a.active === true);
  const points = io.flatMap((g) => g.points);
  const inputs = points.filter((p) => p.kind === "input");
  const outputs = points.filter((p) => p.kind === "output");
  const onCount = (list: typeof points) => list.filter((p) => p.value === true).length;
  const errors = health.filter((f) => f.severity === "error").length;
  const warnings = health.filter((f) => f.severity === "warning").length;

  const firstTask = project.tasks[0];
  const firstProgram = firstTask ? project.programs.find((p) => p.name === firstTask.programs[0]) : project.programs[0];
  const startRoutine = firstProgram?.mainRoutine ?? firstProgram?.routines[0]?.name;

  const tiles: [string, number | string, Location | undefined][] = logix
    ? [
        ["Programs", s.programCount, { view: "structure" }],
        ["Routines", s.routineCount, { view: "structure" }],
        ["Rungs", s.rungCount, undefined],
        ["Tags", s.tagCount, { view: "tags", scope: "" }],
        ["Add-On Instructions", s.aoiCount, undefined],
        ["I/O modules", s.moduleCount, { view: "modules" }],
      ]
    : [
        ["Program files", s.programCount, { view: "structure" }],
        ["Rungs", s.rungCount, undefined],
        ["Data files", s.dataFileCount, undefined],
        ["I/O points", points.length, { view: "io" }],
        ["Documented addresses", s.symbolCount, undefined],
        ["Forces", s.forceCount, s.forceCount ? { view: "health" } : undefined],
      ];

  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">{logix ? "Logix controller" : project.platform === "slc" ? "SLC 500 processor" : "PLC-5 processor"}</div>
        <div className="view-title-row">
          <h1 className="view-title">{project.name}</h1>
          {c.processorType ? <span className="chip">{c.processorType}</span> : null}
        </div>
        {c.description ? <p className="view-desc">{c.description}</p> : null}
        <p className="muted small snapshot-line">
          {snapshot ? (
            <>
              Values in this file were saved <strong>{snapshot}</strong> (processor clock) — every ON/OFF shown is from then, not live.
            </>
          ) : (
            "ON/OFF states are the values saved in the export file, not live readings."
          )}
        </p>
      </header>

      <section className="card start-card">
        <div>
          <h2 className="card-title">Something not working on the machine?</h2>
          <p className="muted small">Pick the output that isn&apos;t doing what it should and follow the logic back to the condition that&apos;s blocking it.</p>
        </div>
        <div className="pill-row">
          <button type="button" className="btn primary" onClick={() => onNavigate({ view: "assistant" })}>
            ✦ Describe the problem to AI
          </button>
          <button type="button" className="btn" onClick={() => onNavigate({ view: "troubleshoot" })}>
            Troubleshoot an output
          </button>
          <button type="button" className="btn" onClick={() => onNavigate({ view: "health" })}>
            Health checks
            {errors ? <span className="chip danger small">{errors}</span> : null}
            {warnings ? <span className="chip warn small">{warnings}</span> : null}
          </button>
        </div>
      </section>

      <section className="card-grid">
        {tiles.map(([label, value, loc]) => (
          <button key={label} type="button" className="stat-tile" disabled={!loc} onClick={() => loc && onNavigate(loc)}>
            <span className="stat-value">{value.toLocaleString()}</span>
            <span className="stat-label">{label}</span>
          </button>
        ))}
      </section>

      <div className="dash-grid">
        <section className="card">
          <h2 className="card-title">
            Alarms &amp; faults
            <button type="button" className="link small" onClick={() => onNavigate({ view: "alarms" })}>
              All {alarms.length} →
            </button>
          </h2>
          {activeAlarms.length === 0 ? (
            <p className="muted small">No alarm or fault bits were ON when the file was saved.</p>
          ) : (
            <>
              <p className="small dash-lead">
                <strong>{activeAlarms.length}</strong> ON when the file was saved:
              </p>
              <ul className="dash-list">
                {activeAlarms.slice(0, 7).map((a) => (
                  <li key={a.label}>
                    <button type="button" className="dash-item" onClick={() => onSelect({ kind: "ref", ref: a.ref, where: a.where })}>
                      <StateBadge value={a.active} />
                      <span className="dash-text">
                        <span className="mono">{a.label}</span>
                        <span className="muted small">{a.description ?? a.comment}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">
            Needs attention
            <button type="button" className="link small" onClick={() => onNavigate({ view: "health" })}>
              Health checks →
            </button>
          </h2>
          {attention.length === 0 ? (
            <p className="muted small">No problems or warnings found.</p>
          ) : (
            <ul className="dash-list">
              {attention.map((f) => (
                <li key={f.id}>
                  <button type="button" className="dash-item" onClick={() => onNavigate({ view: "health" })}>
                    <span className={`sev ${f.severity}`}>{f.severity === "error" ? "●" : "▲"}</span>
                    <span className="dash-text">
                      <span>{f.title}</span>
                      <span className="muted small">
                        {f.items[0]?.label}
                        {f.total > 1 ? ` and ${f.total - 1} more` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">
            Scan structure
            <button type="button" className="link small" onClick={() => onNavigate({ view: "structure" })}>
              Call tree →
            </button>
          </h2>
          <ul className="dash-list">
            {structure.tasks.map((t) => (
              <li key={t.name}>
                <button type="button" className="dash-item" onClick={() => onNavigate({ view: "structure" })}>
                  <span className="dash-text">
                    <span>
                      {t.name} <span className="muted small">{t.kind}</span>
                    </span>
                    <span className="muted small">{t.programs.map((p) => p.name).join(", ")}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">
            {countRoutines(structure)} routines reached through JSR calls
            {structure.unreachable.length ? ` · ${structure.unreachable.length} not reached from any task` : ""}
          </p>
        </section>

        <section className="card">
          <h2 className="card-title">
            I/O
            <button type="button" className="link small" onClick={() => onNavigate({ view: "io" })}>
              I/O map →
            </button>
          </h2>
          {points.length === 0 ? (
            <p className="muted small">No I/O points found.</p>
          ) : (
            <>
              <div className="io-summary">
                <div>
                  <span className="stat-value">{inputs.length}</span>
                  <span className="stat-label">inputs{inputs.some((p) => typeof p.value === "boolean") ? ` · ${onCount(inputs)} ON` : ""}</span>
                </div>
                <div>
                  <span className="stat-value">{outputs.length}</span>
                  <span className="stat-label">outputs{outputs.some((p) => typeof p.value === "boolean") ? ` · ${onCount(outputs)} ON` : ""}</span>
                </div>
                <div>
                  <span className="stat-value">{io.length}</span>
                  <span className="stat-label">{logix ? "modules / I/O images" : project.platform === "slc" ? "slots" : "rack groups"}</span>
                </div>
              </div>
              <ul className="dash-list compact">
                {io.slice(0, 6).map((g) => (
                  <li key={g.title} className="muted small">
                    <span className="mono">{g.title}</span> — {g.points.length} point{g.points.length === 1 ? "" : "s"}
                    {g.subtitle && logix ? ` · ${g.subtitle}` : ""}
                  </li>
                ))}
                {io.length > 6 ? <li className="muted small">…and {io.length - 6} more</li> : null}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="card">
        <h2 className="card-title">Controller</h2>
        <dl className="facts">
          <div className="fact">
            <span>Processor</span>
            <span className="mono">
              {c.processorType ?? "—"}
              {c.series ? ` Series ${c.series}` : ""}
              {c.revision ? ` Rev ${c.revision}` : ""}
            </span>
          </div>
          {c.majorRevision !== undefined ? (
            <div className="fact">
              <span>Firmware</span>
              <span className="mono">v{c.majorRevision}</span>
            </div>
          ) : null}
          {c.serialNumber ? (
            <div className="fact">
              <span>Serial</span>
              <span className="mono">{c.serialNumber}</span>
            </div>
          ) : null}
          <div className="fact">
            <span>Files</span>
            <span>
              {project.sources.map((src) => (
                <span key={src.name} className="file-pill mono">
                  {src.name} <span className="muted">{fmtSize(src.size)}</span>
                </span>
              ))}
            </span>
          </div>
        </dl>
        {firstProgram && startRoutine ? (
          <button
            type="button"
            className="btn primary"
            onClick={() => onNavigate({ view: "routine", ref: { kind: "program", owner: firstProgram.name, routine: startRoutine } })}
          >
            Open {logix ? `${firstProgram.name} › ${startRoutine}` : `${firstProgram.number} - ${firstProgram.name}`}
          </button>
        ) : null}
      </section>

      {project.warnings.length ? (
        <section className="card">
          <h2 className="card-title">Import notes</h2>
          <ul className="plain">
            {project.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
