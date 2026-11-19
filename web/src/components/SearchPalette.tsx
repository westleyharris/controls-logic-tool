import { useEffect, useMemo, useRef, useState } from "react";
import { searchItems, type SearchItem, type SearchKind } from "../lib/search";

export const KIND_LABEL: Record<SearchKind, string> = {
  alarm: "Alarm",
  routine: "Routine",
  tag: "Tag",
  aoi: "AOI",
  datafile: "Data file",
  datatype: "Type",
  module: "Module",
  comment: "Comment",
};

export function SearchPalette({
  items,
  onPick,
  onClose,
}: {
  items: SearchItem[];
  onPick: (item: SearchItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => searchItems(items, query), [items, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search tags, addresses, descriptions, routines, comments…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && results[active]) {
              onPick(results[active]);
            }
          }}
        />
        <ul className="palette-results" ref={listRef}>
          {query.trim() && results.length === 0 ? <li className="palette-empty">No matches.</li> : null}
          {!query.trim() ? (
            <li className="palette-empty">
              Try an address like <span className="mono">O:011/1</span>, a tag like <span className="mono">Motor</span>, or
              words from a description.
            </li>
          ) : null}
          {results.map((item, i) => (
            <li key={`${item.kind}:${item.label}:${i}`}>
              <button
                type="button"
                data-i={i}
                className={`palette-item ${i === active ? "active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(item)}
              >
                <span className={`kind kind-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
                <span className="palette-label mono">{item.label}</span>
                {item.detail ? <span className="palette-detail">{item.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="palette-foot muted small">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
