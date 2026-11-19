import { useState } from "react";
import type { HealthFinding } from "@core/logic/health";
import type { Location, Selection } from "../lib/nav";

const ICON: Record<HealthFinding["severity"], string> = { error: "●", warning: "▲", info: "i" };
const LABEL: Record<HealthFinding["severity"], string> = { error: "Problem", warning: "Warning", info: "Note" };

export function HealthView({
  findings,
  snapshot,
  onNavigate,
  onSelect,
}: {
  findings: HealthFinding[];
  snapshot?: string;
  onNavigate: (loc: Location) => void;
  onSelect: (sel: Selection) => void;
}) {
  const count = (s: HealthFinding["severity"]) => findings.filter((f) => f.severity === s).length;
  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">Health checks</div>
        <div className="view-title-row">
          <h1 className="view-title">Program health</h1>
          <span className={`chip ${count("error") ? "danger" : ""}`}>{count("error")} problems</span>
          <span className={`chip ${count("warning") ? "warn" : ""}`}>{count("warning")} warnings</span>
          <span className="chip">{count("info")} notes</span>
        </div>
        <p className="view-desc">
          Checked across the whole program and the values saved with it{snapshot ? ` (saved ${snapshot})` : ""}. Click an item to jump to the rung
          or inspect the tag.
        </p>
      </header>
      {findings.length === 0 ? <div className="empty-state">Nothing to report.</div> : null}
      <div className="findings">
        {findings.map((f) => (
          <Finding key={f.id} f={f} onNavigate={onNavigate} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}

function Finding({
  f,
  onNavigate,
  onSelect,
}: {
  f: HealthFinding;
  onNavigate: (loc: Location) => void;
  onSelect: (sel: Selection) => void;
}) {
  const [open, setOpen] = useState(f.severity !== "info" && f.total <= 25);
  return (
    <section className={`finding ${f.severity}`}>
      <button type="button" className="finding-head" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <span className={`sev ${f.severity}`} aria-label={LABEL[f.severity]}>
          {ICON[f.severity]}
        </span>
        <span className="finding-title">{f.title}</span>
        <span className="count">{f.total}</span>
        <span className={`twisty ${open ? "open" : ""}`} aria-hidden>
          ▸
        </span>
      </button>
      <p className="finding-summary">{f.summary}</p>
      {open ? (
        <ul className="finding-items">
          {f.items.map((it, i) => (
            <li key={i}>
              <button
                type="button"
                className="finding-item"
                disabled={!it.at && !it.ref}
                onClick={() => {
                  if (it.at) onNavigate({ view: "routine", ref: it.at.where, rung: it.at.rung });
                  if (it.ref) onSelect({ kind: "ref", ref: it.ref.ref, where: it.ref.where, ...(it.at ? { rung: it.at.rung } : {}) });
                  else if (it.at) onSelect({ kind: "rung", where: it.at.where, rung: it.at.rung });
                }}
              >
                <span className="mono">{it.label}</span>
                {it.detail ? <span className="muted small">{it.detail}</span> : null}
              </button>
            </li>
          ))}
          {f.total > f.items.length ? <li className="muted small">…and {f.total - f.items.length} more</li> : null}
        </ul>
      ) : null}
    </section>
  );
}
