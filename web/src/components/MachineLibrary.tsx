import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ProjectModel } from "@core/model/types";
import {
  companiesOf,
  groupMachines,
  linesOf,
  NO_COMPANY,
  NO_LINE,
  platformLabel,
  type MachineDetails,
  type MachineSummary,
} from "../lib/machines";
import { FilePicker } from "./FilePicker";

function when(ts: number | undefined): string {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* -------------------------- collapsed groups (remembered) -------------------------- */

const COLLAPSE_KEY = "clt-library-collapsed";

function useCollapsed(): [Set<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  return [collapsed, toggle];
}

/* ------------------------------- company / line fields ------------------------------ */

/** Company + Line inputs with suggestions from what's already in the library. */
function OrgFields({
  machines,
  company,
  line,
  onCompany,
  onLine,
}: {
  machines: MachineSummary[];
  company: string;
  line: string;
  onCompany: (v: string) => void;
  onLine: (v: string) => void;
}) {
  const id = useId();
  const companies = useMemo(() => companiesOf(machines), [machines]);
  const lines = useMemo(() => linesOf(machines, company), [machines, company]);
  return (
    <>
      <label className="field">
        <span>Company</span>
        <input
          className="input"
          list={`${id}-companies`}
          value={company}
          placeholder="e.g. customer or plant name"
          onChange={(e) => onCompany(e.target.value)}
        />
        <datalist id={`${id}-companies`}>
          {companies.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label className="field">
        <span>Line</span>
        <input className="input" list={`${id}-lines`} value={line} placeholder="e.g. Line 3" onChange={(e) => onLine(e.target.value)} />
        <datalist id={`${id}-lines`}>
          {lines.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
      </label>
    </>
  );
}

/* ----------------------------------- library ----------------------------------- */

export function MachineLibrary({
  machines,
  error,
  onOpen,
  onAdd,
  onEdit,
  onRenameCompany,
  onRenameLine,
  onUpdateExport,
  onDelete,
  cloudEmail,
}: {
  machines: MachineSummary[];
  error: string | null;
  /** Signed-in account, when the library syncs to the cloud. */
  cloudEmail?: string | undefined;
  onOpen: (id: string) => void;
  /** Pick export files; `preset` pre-fills company/line in the add dialog. */
  onAdd: (files: File[], preset?: { company: string; line: string }) => void;
  onEdit: (id: string, details: MachineDetails) => void;
  onRenameCompany: (from: string, to: string) => void;
  onRenameLine: (company: string, from: string, to: string) => void;
  onUpdateExport: (id: string, files: File[]) => void;
  onDelete: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [collapsed, toggle] = useCollapsed();
  const q = filter.trim().toLowerCase();
  const shown = machines.filter(
    (m) =>
      !q ||
      [m.name, m.company, m.line, m.location, m.projectName, m.processor, ...m.fileNames].some((s) => s?.toLowerCase().includes(q)),
  );
  const groups = groupMachines(shown);
  const companyCount = companiesOf(machines).length;
  const lineCount = new Set(machines.filter((m) => m.line).map((m) => `${m.company ?? ""}|${m.line}`)).size;

  const machineRow = (m: MachineSummary) =>
    editing === m.id ? (
      <li key={m.id}>
        <EditMachineForm
          machine={m}
          machines={machines}
          onCancel={() => setEditing(null)}
          onSave={(d) => {
            onEdit(m.id, d);
            setEditing(null);
          }}
        />
      </li>
    ) : (
      <li key={m.id} className="machine-row">
        <button type="button" className="machine-main" onClick={() => onOpen(m.id)}>
          <span className="machine-name">{m.name}</span>
          <span className="machine-meta">
            <span className="chip">{platformLabel(m.platform)}</span>
            {m.processor ? <span className="mono small">{m.processor}</span> : null}
            {m.location ? <span>{m.location}</span> : null}
            {m.remote ? (
              <span className="chip small cloud-chip" title="In your cloud library — downloads the first time you open it">
                ☁ in the cloud
              </span>
            ) : m.dirty || m.filesDirty ? (
              cloudEmail ? (
                <span className="chip small" title="Changes not uploaded yet">
                  waiting to sync
                </span>
              ) : null
            ) : null}
          </span>
          <span className="machine-files muted small">
            {m.projectName && m.projectName !== m.name ? `${m.projectName} · ` : ""}
            {m.fileNames.join(", ")}
          </span>
          <span className="machine-when muted small">{m.openedAt ? `Opened ${when(m.openedAt)}` : m.remote ? "Not on this device yet" : `Opened ${when(m.openedAt)}`}</span>
        </button>
        <div className="machine-tools">
          <button type="button" className="btn ghost small" onClick={() => setEditing(m.id)}>
            Edit
          </button>
          <FilePicker className="btn ghost small" onFiles={(files) => onUpdateExport(m.id, files)} title="Replace this machine's export with a newer one">
            Update export
          </FilePicker>
          <button
            type="button"
            className="btn ghost small danger"
            onClick={() => {
              if (window.confirm(`Delete “${m.name}” from this browser? Its export files stored here will be removed.`)) onDelete(m.id);
            }}
          >
            Delete
          </button>
        </div>
      </li>
    );

  return (
    <div className="library">
      <header className="library-head">
        <div>
          <h1 className="view-title">Machines</h1>
          <p className="muted small">
            {plural(machines.length, "machine")}
            {companyCount ? ` · ${plural(companyCount, "company").replace("companys", "companies")}` : ""}
            {lineCount ? ` · ${plural(lineCount, "line")}` : ""} — {cloudEmail ? `synced to ${cloudEmail}` : "saved in this browser"}
          </p>
        </div>
        <div className="library-actions">
          {machines.length > 4 ? (
            <input className="input" placeholder="Find a company, line or machine…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          ) : null}
          <FilePicker className="btn primary" onFiles={(f) => onAdd(f)} title="Pick the machine's .PC5 + .SY6, .SLC, .L5K or .L5X export">
            + Add machine
          </FilePicker>
        </div>
      </header>

      {error ? <div className="notice error">{error}</div> : null}

      {machines.length === 0 ? (
        <div className="library-empty">
          <h2>No machines yet</h2>
          <p className="muted">
            Add a machine by picking its PLC export — <span className="mono">.PC5</span> with its <span className="mono">.SY6</span> for
            PLC-5, the <span className="mono">.SLC</span> for SLC 500, or the <span className="mono">.L5K</span> /{" "}
            <span className="mono">.L5X</span> for ControlLogix / CompactLogix. You&apos;ll file it under a company and line.
          </p>
          <FilePicker className="btn primary" onFiles={(f) => onAdd(f)}>
            + Add machine
          </FilePicker>
        </div>
      ) : shown.length === 0 ? (
        <p className="muted">Nothing matches “{filter}”.</p>
      ) : (
        <div className="org">
          {groups.map((c) => {
            const cKey = `c:${c.key}`;
            const cOpen = !!q || !collapsed.has(cKey);
            const machinesIn = c.lines.reduce((a, l) => a + l.machines.length, 0);
            return (
              <section key={cKey} className={`org-company ${c.key ? "" : "unassigned"}`}>
                <div className="org-head company">
                  <button type="button" className={`twisty ${cOpen ? "open" : ""}`} onClick={() => toggle(cKey)} aria-label={cOpen ? "Collapse" : "Expand"}>
                    ▸
                  </button>
                  {renaming === cKey ? (
                    <GroupRename
                      initial={c.key}
                      placeholder={c.key ? "Company name" : "Company for these machines"}
                      onCancel={() => setRenaming(null)}
                      onSave={(to) => {
                        onRenameCompany(c.key, to);
                        setRenaming(null);
                      }}
                    />
                  ) : (
                    <>
                      <button type="button" className="org-name" onClick={() => toggle(cKey)}>
                        <span className="ico ico-company" aria-hidden />
                        {c.company}
                      </button>
                      <span className="muted small">
                        {plural(c.lines.filter((l) => l.key).length, "line")} · {plural(machinesIn, "machine")}
                      </span>
                      <span className="org-tools">
                        <button type="button" className="btn ghost small" onClick={() => setRenaming(cKey)}>
                          {c.key ? "Rename" : "Assign company"}
                        </button>
                        <FilePicker className="btn ghost small" onFiles={(f) => onAdd(f, { company: c.key, line: "" })}>
                          + Machine
                        </FilePicker>
                      </span>
                    </>
                  )}
                </div>
                {cOpen
                  ? c.lines.map((l) => {
                      const lKey = `l:${c.key}|${l.key}`;
                      const lOpen = !!q || !collapsed.has(lKey);
                      return (
                        <div key={lKey} className={`org-line ${l.key ? "" : "unassigned"}`}>
                          <div className="org-head line">
                            <button
                              type="button"
                              className={`twisty ${lOpen ? "open" : ""}`}
                              onClick={() => toggle(lKey)}
                              aria-label={lOpen ? "Collapse" : "Expand"}
                            >
                              ▸
                            </button>
                            {renaming === lKey ? (
                              <GroupRename
                                initial={l.key}
                                placeholder={l.key ? "Line name" : "Line for these machines"}
                                onCancel={() => setRenaming(null)}
                                onSave={(to) => {
                                  onRenameLine(c.key, l.key, to);
                                  setRenaming(null);
                                }}
                              />
                            ) : (
                              <>
                                <button type="button" className="org-name" onClick={() => toggle(lKey)}>
                                  <span className="ico ico-line" aria-hidden />
                                  {l.line}
                                </button>
                                <span className="muted small">{plural(l.machines.length, "machine")}</span>
                                <span className="org-tools">
                                  <button type="button" className="btn ghost small" onClick={() => setRenaming(lKey)}>
                                    {l.key ? "Rename" : "Assign line"}
                                  </button>
                                  <FilePicker className="btn ghost small" onFiles={(f) => onAdd(f, { company: c.key, line: l.key })}>
                                    + Machine
                                  </FilePicker>
                                </span>
                              </>
                            )}
                          </div>
                          {lOpen ? <ul className="machine-list">{l.machines.map(machineRow)}</ul> : null}
                        </div>
                      );
                    })
                  : null}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GroupRename({
  initial,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onSave: (to: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="group-rename"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() !== initial) onSave(value.trim());
        else onCancel();
      }}
    >
      <input
        className="input small"
        value={value}
        placeholder={placeholder}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      />
      <button type="submit" className="btn primary small">
        Save
      </button>
      <button type="button" className="btn ghost small" onClick={onCancel}>
        Cancel
      </button>
    </form>
  );
}

function EditMachineForm({
  machine,
  machines,
  onSave,
  onCancel,
}: {
  machine: MachineSummary;
  machines: MachineSummary[];
  onSave: (d: MachineDetails) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(machine.name);
  const [company, setCompany] = useState(machine.company ?? "");
  const [line, setLine] = useState(machine.line ?? "");
  const [notes, setNotes] = useState(machine.location ?? "");
  return (
    <form
      className="machine-edit"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave({ name: name.trim(), company: company.trim(), line: line.trim(), notes: notes.trim() });
      }}
    >
      <OrgFields machines={machines} company={company} line={line} onCompany={setCompany} onLine={setLine} />
      <label className="field">
        <span>Machine name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <label className="field">
        <span>Notes</span>
        <input className="input" value={notes} placeholder="Optional — area, OEM, anything" onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="edit-actions">
        <button type="submit" className="btn primary">
          Save
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Shown after picking files for a new machine: confirm what was read and file it. */
export function AddMachineDialog({
  model,
  fileNames,
  machines,
  preset,
  onSave,
  onCancel,
}: {
  model: ProjectModel;
  fileNames: string[];
  machines: MachineSummary[];
  preset?: { company: string; line: string; name?: string } | undefined;
  onSave: (d: MachineDetails) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(preset?.name || model.name);
  const [company, setCompany] = useState(preset?.company ?? "");
  const [line, setLine] = useState(preset?.line ?? "");
  const [notes, setNotes] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.select();
  }, []);
  const s = model.stats;
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave({ name: name.trim(), company: company.trim(), line: line.trim(), notes: notes.trim() });
        }}
      >
        <h2 className="modal-title">Add machine</h2>
        <p className="muted small">
          Read {fileNames.join(", ")} — {platformLabel(model.platform)}
          {model.controller.processorType ? ` ${model.controller.processorType}` : ""}, {s.programCount} programs,{" "}
          {s.rungCount.toLocaleString()} rungs.
        </p>
        {model.warnings.length ? (
          <ul className="notice small">
            {model.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        ) : null}
        <div className="org-fields">
          <OrgFields machines={machines} company={company} line={line} onCompany={setCompany} onLine={setLine} />
        </div>
        <label className="field">
          <span>Machine name</span>
          <input ref={nameRef} className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Notes</span>
          <input className="input" value={notes} placeholder="Optional — area, OEM, anything" onChange={(e) => setNotes(e.target.value)} />
        </label>
        <p className="muted small">
          Filed under {company.trim() || NO_COMPANY} › {line.trim() || NO_LINE}. You can change this later with Edit.
        </p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            Save and open
          </button>
        </div>
      </form>
    </div>
  );
}
