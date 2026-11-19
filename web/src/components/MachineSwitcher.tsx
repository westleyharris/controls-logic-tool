import { useEffect, useRef, useState } from "react";
import { groupMachines, platformLabel, type MachineSummary } from "../lib/machines";
import { FilePicker } from "./FilePicker";
import { Icon } from "./Icon";

/** Top-bar dropdown: jump to another saved machine, the library, or add one. */
export function MachineSwitcher({
  current,
  machines,
  onOpen,
  onLibrary,
  onAdd,
}: {
  current: MachineSummary;
  machines: MachineSummary[];
  onOpen: (id: string) => void;
  onLibrary: () => void;
  onAdd: (files: File[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="switcher" ref={ref}>
      <button type="button" className="switcher-btn" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        {current.company || current.line ? (
          <span className="muted small crumbs-org">
            {[current.company, current.line].filter(Boolean).join(" › ")} ›
          </span>
        ) : null}
        <span className="project-name">{current.name}</span>
        <span className="muted small switcher-proc">{current.processor ?? platformLabel(current.platform)}</span>
        <Icon name="chevron-down" size={15} className="caret" />
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="menu-label">Switch machine</div>
          {groupMachines(machines).map((c) => (
            <div key={`c:${c.key}`} className="menu-group">
              <div className="menu-company">{c.company}</div>
              {c.lines.map((l) => (
                <div key={`l:${l.key}`}>
                  {c.lines.length > 1 || l.key ? <div className="menu-line">{l.line}</div> : null}
                  <ul>
                    {l.machines.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          className={`menu-item ${m.id === current.id ? "current" : ""}`}
                          onClick={() => {
                            setOpen(false);
                            if (m.id !== current.id) onOpen(m.id);
                          }}
                        >
                          <span>{m.name}</span>
                          <span className="muted small">
                            {platformLabel(m.platform)}
                            {m.processor ? ` · ${m.processor}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ))}
          <div className="menu-sep" />
          <FilePicker className="menu-item" onFiles={(f) => {
              setOpen(false);
              onAdd(f);
            }}>
            + Add machine…
          </FilePicker>
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onLibrary();
            }}
          >
            All machines
          </button>
        </div>
      ) : null}
    </div>
  );
}
