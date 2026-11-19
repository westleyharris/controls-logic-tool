import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { RoutineRef, Rung } from "@core/model/types";
import type { AoiInstance, ProjectIndex } from "@core/query/index";
import { routineContext } from "../lib/ai";
import { findAoiCalls } from "../lib/aoiCalls";
import { explainOutputs, tidyComment } from "../lib/explain";
import type { Location, RoutineScope, Selection } from "../lib/nav";
import { evaluate } from "../lib/power";
import type { LadderPrefs } from "../lib/prefs";
import { AskAi } from "./AskAi";
import { LadderDiagram } from "./LadderDiagram";
import { OutputTree } from "./OutputTree";

const NO_RUNGS: Rung[] = [];

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Toggle({ on, label, title, onChange }: { on: boolean; label: string; title: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`toggle ${on ? "on" : ""}`} aria-pressed={on} title={title} onClick={() => onChange(!on)}>
      <span className="toggle-dot" aria-hidden />
      {label}
    </button>
  );
}

export function RoutineView({
  index,
  where: ref,
  instance,
  focusRung,
  selection,
  prefs,
  onPrefs,
  onSelect,
  onNavigate,
}: {
  index: ProjectIndex;
  where: RoutineRef;
  instance?: AoiInstance;
  focusRung?: number;
  selection: Selection | null;
  prefs: LadderPrefs;
  onPrefs: (patch: Partial<LadderPrefs>) => void;
  onSelect: (sel: Selection) => void;
  onNavigate: (loc: Location) => void;
}) {
  const where = useMemo<RoutineScope>(() => (instance ? { ...ref, instance } : ref), [ref, instance]);
  const routine = index.routine(where);
  const calls = useMemo(() => {
    if (where.kind !== "aoi") return [];
    const seen = new Set<string>();
    return findAoiCalls(index, where.owner).filter((c) => {
      const k = `${c.where.kind}|${c.where.owner}|${c.instance}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [index, where.kind, where.owner]);
  const enableIn = instance ? index.resolve("EnableIn", where) : undefined;
  const owner = where.kind === "aoi" ? index.aoi(where.owner) : index.program(where.owner);
  const [filter, setFilter] = useState("");
  const [goto, setGoto] = useState("");
  const [showAi, setShowAi] = useState(false);
  const [viewRef, viewWidth] = useWidth<HTMLDivElement>();

  const highlightKey = useMemo(() => {
    if (selection?.kind !== "ref") return undefined;
    return index.resolve(selection.ref, selection.where).key;
  }, [index, selection]);

  const rungs = routine?.rungs ?? NO_RUNGS;
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rungs;
    return rungs.filter((r) => `${r.text} ${r.comment ?? ""} ${r.title ?? ""}`.toLowerCase().includes(q));
  }, [rungs, filter]);

  if (!routine) {
    return <div className="empty-state">Routine “{where.routine}” not found.</div>;
  }

  const isMain = where.kind === "program" && index.program(where.owner)?.mainRoutine === routine.name;
  const kindLabel =
    routine.type === "ladder" ? "Ladder" : routine.type === "st" ? "Structured Text" : routine.type.toUpperCase();
  // Width for the drawing: pane minus rung-number gutter and padding.
  const ladderWidth = Math.max(420, viewWidth - 52 - 24 - 6);
  const lastRung = rungs.length ? rungs[rungs.length - 1]!.index : 0;

  return (
    <div className="view" ref={viewRef}>
      <header className="view-head">
        <div className="crumbs">
          <button
            type="button"
            className="crumb"
            onClick={() => onNavigate(where.kind === "aoi" ? { view: "aoi", name: where.owner } : { view: "overview" })}
          >
            {where.kind === "aoi" ? `AOI ${where.owner}` : index.isLogix ? `Program ${where.owner}` : "Program Files"}
          </button>
          <span className="crumb-sep">/</span>
        </div>
        <div className="view-title-row">
          <h1 className="view-title">
            {routine.number !== undefined ? `${routine.number} - ` : ""}
            {routine.name}
          </h1>
          <span className="chip">{kindLabel}</span>
          {isMain ? <span className="chip accent">Main routine</span> : null}
          {routine.encoded ? <span className="chip warn">Source protected</span> : null}
          <span className="view-meta">{routine.type === "ladder" ? `${rungs.length} rungs` : null}</span>
          {!routine.encoded ? (
            <button type="button" className={`btn small ${showAi ? "primary" : ""}`} onClick={() => setShowAi((x) => !x)}>
              ✦ Explain routine
            </button>
          ) : null}
        </div>
        {routine.description || owner?.description ? (
          <p className="view-desc">{routine.description ?? owner?.description}</p>
        ) : null}
        {where.kind === "aoi" && routine.type === "ladder" ? (
          <div className="instance-bar">
            {instance ? (
              <>
                <span className="chip accent">Instance</span>
                <span className="mono">{instance.tag}</span>
                <span className="muted small">
                  called from {instance.caller.kind === "aoi" ? "AOI" : "program"} {instance.caller.owner} — values below are
                  this instance&apos;s
                </span>
                {enableIn?.hasValue && enableIn.value === false ? (
                  <span className="chip warn" title="With EnableIn OFF the AOI's logic doesn't run, so these values are frozen from the last time it did">
                    EnableIn OFF — not executing
                  </span>
                ) : null}
              </>
            ) : (
              <span className="muted small">Showing the definition. Pick an instance to see its saved values:</span>
            )}
            {calls.length ? (
              <select
                className="input small instance-select"
                value={instance ? `${instance.caller.kind}|${instance.caller.owner}|${instance.tag}` : ""}
                onChange={(e) => {
                  const call = calls.find((c) => `${c.where.kind}|${c.where.owner}|${c.instance}` === e.target.value);
                  onNavigate(
                    call
                      ? { view: "routine", ref, instance: { tag: call.instance, caller: { kind: call.where.kind, owner: call.where.owner } } }
                      : { view: "routine", ref },
                  );
                }}
              >
                <option value="">Definition only</option>
                {calls.map((c) => (
                  <option key={`${c.where.kind}|${c.where.owner}|${c.instance}`} value={`${c.where.kind}|${c.where.owner}|${c.instance}`}>
                    {c.instance} — {c.where.owner}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ) : null}
      </header>

      {showAi ? (
        <section className="card ai-card">
          <h2 className="card-title">AI overview of {routine.name}</h2>
          <AskAi
            cacheKey={`routine|${where.kind}|${where.owner}|${routine.name}|${JSON.stringify(where.instance ?? null)}`}
            label="Explain this routine"
            what={`all ${rungs.length} rungs of this routine with their comments and tag descriptions/values`}
            buildContext={() => routineContext(index, where, routine)}
          />
        </section>
      ) : null}

      {routine.type === "ladder" && rungs.length > 0 ? (
        <div className="ladder-toolbar">
          <input
            className="input"
            placeholder="Filter rungs by text or comment…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <form
            className="goto"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(goto);
              if (Number.isInteger(n) && rungs.some((r) => r.index === n)) {
                setFilter("");
                onNavigate({ view: "routine", ref, rung: n, ...(instance ? { instance } : {}) });
                onSelect({ kind: "rung", where, rung: n });
              }
            }}
          >
            <input
              className="input"
              inputMode="numeric"
              placeholder={`Rung # (0–${lastRung})`}
              value={goto}
              onChange={(e) => setGoto(e.target.value.replace(/[^\d]/g, ""))}
              aria-label="Go to rung"
            />
          </form>
          <div className="toggles">
            <Toggle
              on={prefs.descriptions}
              label="Descriptions"
              title="Show address / tag descriptions above instructions"
              onChange={(v) => onPrefs({ descriptions: v })}
            />
            <Toggle
              on={prefs.values}
              label="Saved values"
              title="Highlight instructions that were ON in the saved values and show values in blocks"
              onChange={(v) => onPrefs({ values: v })}
            />
            {!index.isLogix ? (
              <Toggle
                on={prefs.symbols}
                label="Symbols"
                title="Show the symbol from the .SY6 instead of the address"
                onChange={(v) => onPrefs({ symbols: v })}
              />
            ) : null}
            <Toggle on={prefs.compact} label="Compact" title="Tighter spacing" onChange={(v) => onPrefs({ compact: v })} />
          </div>
          {filter ? (
            <span className="muted small">
              {visible.length} of {rungs.length}
            </span>
          ) : null}
        </div>
      ) : null}
      {routine.type === "ladder" && prefs.values ? (
        <p className="values-note muted small">
          <span className="legend-on" /> ON in the values saved with the export — a snapshot, not live.
        </p>
      ) : null}

      {routine.encoded ? (
        <div className="notice">
          This routine is source-protected in the export, so its logic can't be shown. Ask the OEM for the source key
          if you need to see inside.
        </div>
      ) : routine.type === "st" ? (
        <StView lines={routine.stLines ?? []} />
      ) : routine.type !== "ladder" ? (
        <div className="notice">{kindLabel} routines aren't drawn yet.</div>
      ) : visible.length === 0 ? (
        <div className="empty-state">{filter ? `No rungs match “${filter}”.` : "This routine has no rungs."}</div>
      ) : (
        <div className={`rungs ${prefs.compact ? "compact" : ""}`}>
          {visible.map((rung) => (
            <RungRow
              key={rung.index}
              rung={rung}
              index={index}
              where={where}
              prefs={prefs}
              width={ladderWidth}
              focused={focusRung === rung.index}
              selected={
                (selection?.kind === "rung" || selection?.kind === "ref") &&
                selection.where.owner === where.owner &&
                selection.where.routine === where.routine &&
                selection.rung === rung.index
              }
              highlightKey={highlightKey}
              onSelect={onSelect}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const RungRow = memo(function RungRow({
  rung,
  index,
  where,
  prefs,
  width,
  focused,
  selected,
  highlightKey,
  onSelect,
  onNavigate,
}: {
  rung: Rung;
  index: ProjectIndex;
  where: RoutineScope;
  prefs: LadderPrefs;
  width: number;
  focused: boolean;
  selected: boolean;
  highlightKey?: string;
  onSelect: (sel: Selection) => void;
  onNavigate: (loc: Location) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);

  const comment = tidyComment(rung.comment);
  const tree = useMemo(() => explainOutputs(rung, index, where), [rung, index, where]);
  const status = prefs.values && rung.ladder ? evaluate(rung.ladder, index, where).out : null;
  const longComment = (comment?.split("\n").length ?? 0) > 4 || (comment?.length ?? 0) > 420;

  return (
    <article
      ref={ref}
      className={`rung ${focused ? "focused" : ""} ${selected ? "selected" : ""}`}
      onClick={() => onSelect({ kind: "rung", where, rung: rung.index })}
    >
      <div className="rung-num mono">
        {rung.index}
        {status !== null ? (
          <span
            className={`rung-status ${status ? "on" : "off"}`}
            title={status ? "Rung is true in the saved values" : "Rung is false in the saved values"}
          />
        ) : null}
      </div>
      <div className="rung-body">
        {rung.title ? <div className="rung-title">{rung.title}</div> : null}
        {comment ? (
          <div className={`rung-comment ${longComment && !expanded ? "clamped" : ""}`}>
            {comment}
            {longComment ? (
              <button
                type="button"
                className="link small"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((x) => !x);
                }}
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            ) : null}
          </div>
        ) : null}
        {rung.ladder ? (
          <LadderDiagram
            root={rung.ladder}
            index={index}
            where={where}
            prefs={prefs}
            minWidth={width}
            highlightKey={highlightKey}
            onSelectRef={(r) => onSelect({ kind: "ref", ref: r, where, rung: rung.index })}
            onJump={(target, inst) => onNavigate({ view: "routine", ref: target, ...(inst ? { instance: inst } : {}) })}
          />
        ) : (
          <pre className="rung-text">{rung.text}</pre>
        )}
        {!prefs.compact && (tree.actions.length || tree.children.length) ? (
          <div className="rung-summary">
            <OutputTree root={tree} compact />
          </div>
        ) : null}
      </div>
    </article>
  );
});

const ST_KEYWORDS = new Set(
  "IF THEN ELSE ELSIF END_IF CASE OF END_CASE FOR TO BY DO END_FOR WHILE END_WHILE REPEAT UNTIL END_REPEAT EXIT RETURN AND OR XOR NOT MOD TRUE FALSE".split(
    " ",
  ),
);

type StTok = { cls: string; text: string };

/** Tokenize Structured Text for highlighting (block comments may span lines). */
function highlightSt(lines: string[]): StTok[][] {
  const rules: [RegExp, (text: string) => string][] = [
    [/^'(?:\$.|[^'])*'?/, () => "st-str"],
    [/^(?:\d+#[0-9A-Fa-f_]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/, () => "st-num"],
    [/^[A-Za-z_]\w*/, (t) => (ST_KEYWORDS.has(t.toUpperCase()) ? "st-kw" : "")],
    [/^(?::=|<>|<=|>=|[-+*/<>=;(),.[\]])/, () => "st-op"],
  ];
  let inBlock = false;
  return lines.map((line) => {
    const out: StTok[] = [];
    let i = 0;
    while (i < line.length) {
      const rest = line.slice(i);
      if (inBlock || rest.startsWith("(*")) {
        const end = line.indexOf("*)", inBlock ? i : i + 2);
        const stop = end < 0 ? line.length : end + 2;
        out.push({ cls: "st-comment", text: line.slice(i, stop) });
        inBlock = end < 0;
        i = stop;
        continue;
      }
      if (rest.startsWith("//")) {
        out.push({ cls: "st-comment", text: rest });
        break;
      }
      let matched = false;
      for (const [re, cls] of rules) {
        const m = rest.match(re);
        if (m && m[0]) {
          out.push({ cls: cls(m[0]), text: m[0] });
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        out.push({ cls: "", text: rest[0]! });
        i += 1;
      }
    }
    return out;
  });
}

function StView({ lines }: { lines: string[] }) {
  const toks = useMemo(() => highlightSt(lines), [lines]);
  return (
    <pre className="st-code">
      {toks.map((line, i) => (
        <div key={i} className="st-line">
          <span className="st-num">{i + 1}</span>
          <span>
            {line.length === 0
              ? " "
              : line.map((t, k) =>
                  t.cls ? (
                    <span key={k} className={t.cls}>
                      {t.text}
                    </span>
                  ) : (
                    t.text
                  ),
                )}
          </span>
        </div>
      ))}
    </pre>
  );
}
