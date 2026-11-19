import { useMemo, useState } from "react";
import type { ProjectModel } from "@core/model/types";
import { formatValue } from "@core/query/index";
import type { Selection } from "../lib/nav";

const PAGE = 300;

export function TagsView({
  project,
  scope,
  selection,
  onSelect,
}: {
  project: ProjectModel;
  scope: string;
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
}) {
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const program = scope ? project.programs.find((p) => p.name === scope) : undefined;
  const where = { kind: "program" as const, owner: scope, routine: program?.mainRoutine ?? "" };

  const tags = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return project.tags
      .filter((t) => t.scope === scope)
      .filter(
        (t) =>
          !q ||
          t.name.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.dataType.toLowerCase().includes(q) ||
          t.aliasFor?.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [project.tags, scope, filter]);

  const selectedName = selection?.kind === "ref" ? selection.ref.toUpperCase() : "";

  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">{scope ? `Program ${scope}` : "Controller scope"}</div>
        <div className="view-title-row">
          <h1 className="view-title">{scope ? "Program Tags" : "Controller Tags"}</h1>
          <span className="view-meta">{tags.length} tags</span>
        </div>
        <div className="toolbar">
          <input
            className="input"
            placeholder="Filter by name, description, type or alias…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setLimit(PAGE);
            }}
          />
        </div>
      </header>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Description</th>
              <th className="right">Saved value</th>
            </tr>
          </thead>
          <tbody>
            {tags.slice(0, limit).map((t) => (
              <tr
                key={t.name}
                className={`clickable ${selectedName === t.name.toUpperCase() ? "selected" : ""}`}
                onClick={() => onSelect({ kind: "ref", ref: t.name, where })}
              >
                <td className="mono tag-name">{t.name}</td>
                <td className="mono small tag-type">
                  {t.aliasFor ? <span className="muted">alias → {t.aliasFor}</span> : `${t.dataType}${t.dims ? `[${t.dims.join(",")}]` : ""}`}
                </td>
                <td className="desc-cell">{t.description?.replace(/\s*\n\s*/g, " ")}</td>
                <td className="mono right nowrap">{formatValue(t.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tags.length > limit ? (
          <button type="button" className="btn" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({tags.length - limit} left)
          </button>
        ) : null}
      </div>
    </div>
  );
}
