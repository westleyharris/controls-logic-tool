import { useMemo } from "react";
import type { CrossReferenceHit, LadderNode, SavedValue } from "@core/model/types";
import type { ProjectIndex } from "@core/query/index";
import { formatValue } from "@core/query/index";
import { instructionsOf } from "@core/ladder/parse";
import { instructionHelp, instructionInfo } from "@core/logic/instructions";
import { isConstant, isTagOperand } from "@core/logic/refs";
import type { Blocker } from "@core/logic/evaluate";
import { ioPointOf } from "@core/logic/trace";
import { rungContext, tagContext } from "../lib/ai";
import { describeBlocker, explainOutputs, shortName, tidyComment } from "../lib/explain";
import type { Location, RoutineScope, Selection } from "../lib/nav";
import { evaluate } from "../lib/power";
import { AskAi } from "./AskAi";
import type { Attachment } from "../lib/machines";
import { addressVariants, searchPages } from "../lib/pdf";
import { OutputTree } from "./OutputTree";
import { Icon } from "./Icon";

export function Inspector({
  index,
  attachments,
  selection,
  onSelect,
  onNavigate,
  onClose,
}: {
  index: ProjectIndex;
  attachments: Attachment[];
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
  onNavigate: (loc: Location) => void;
  onClose: () => void;
}) {
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="pane-head">
        <span className="pane-title">{selection?.kind === "rung" ? "Explain" : "Inspector"}</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Hide inspector" title="Hide inspector">
          <Icon name="x" />
        </button>
      </div>
      <div className="pane-scroll">
        {!selection ? (
          <div className="inspector-empty">
            <p>
              <strong>Click a rung</strong> (its background or number) to get it explained: what it does, whether it’s true in
              the saved values, and which condition is blocking each output.
            </p>
            <p>
              <strong>Click an instruction</strong> to see that tag’s description, saved value, and everywhere it’s written
              and read.
            </p>
            <p className="muted small">
              Press <kbd>⌘</kbd> <kbd>K</kbd> to search tags, addresses, routines and comments.
            </p>
          </div>
        ) : selection.kind === "ref" ? (
          <RefPanel index={index} attachments={attachments} selection={selection} onSelect={onSelect} onNavigate={onNavigate} />
        ) : (
          <RungPanel index={index} where={selection.where} rung={selection.rung} onSelect={onSelect} onNavigate={onNavigate} />
        )}
      </div>
    </aside>
  );
}

function locLabel(index: ProjectIndex, h: Pick<CrossReferenceHit, "kind" | "owner" | "routine">): string {
  if (h.kind === "aoi") return `${h.owner} › ${h.routine}`;
  if (!index.isLogix) {
    const p = index.program(h.owner);
    return `${p?.number ?? ""} - ${h.owner}`;
  }
  return `${h.owner} › ${h.routine}`;
}

function ValueView({ value }: { value: SavedValue }) {
  if (typeof value === "boolean") {
    return <span className={`bool ${value ? "on" : "off"}`}>{value ? "1 · ON" : "0 · OFF"}</span>;
  }
  if (typeof value !== "object") return <span className="big-value mono">{formatValue(value, 200)}</span>;
  const entries: [string, SavedValue][] = Array.isArray(value)
    ? value.slice(0, 64).map((v, i) => [`[${i}]`, v])
    : Object.entries(value).slice(0, 120);
  return (
    <div className="kv">
      {entries.map(([k, v]) => (
        <div key={k} className="kv-row">
          <span className="kv-k mono">{k}</span>
          <span className={`kv-v mono ${typeof v === "boolean" ? (v ? "on" : "off") : ""}`}>{formatValue(v)}</span>
        </div>
      ))}
      {Array.isArray(value) && value.length > 64 ? <div className="muted small">…{value.length - 64} more</div> : null}
    </div>
  );
}

const stripScope = (key: string) => key.replace(/^(Program|AOI):[^.]+\./, "");

function RefPanel({
  index,
  attachments,
  selection,
  onSelect,
  onNavigate,
}: {
  index: ProjectIndex;
  attachments: Attachment[];
  selection: Extract<Selection, { kind: "ref" }>;
  onSelect: (sel: Selection) => void;
  onNavigate: (loc: Location) => void;
}) {
  const info = useMemo(() => index.resolve(selection.ref, selection.where), [index, selection]);
  const hits = useMemo(() => index.hitsRelated(info.key, info.base), [index, info]);
  const writes = hits.filter((h) => h.access === "write");
  const reads = hits.filter((h) => h.access === "read");
  const baseRef = stripScope(info.base);
  const io = useMemo(() => ioPointOf(index, info), [index, info]);
  const onDrawings = useMemo(() => {
    const terms = addressVariants(stripScope(info.key));
    if (info.symbol && info.symbol !== info.key && info.symbol.length > 3) terms.push(info.symbol);
    return searchPages(attachments, terms, 8);
  }, [attachments, info]);
  const baseInfo = info.base !== info.key ? index.resolve(baseRef, selection.where) : null;

  const jump = (h: CrossReferenceHit) => {
    const sameAoi = h.kind === "aoi" && selection.where.kind === "aoi" && h.owner === selection.where.owner;
    const instance = sameAoi ? selection.where.instance : undefined;
    onNavigate({ view: "routine", ref: { kind: h.kind, owner: h.owner, routine: h.routine }, rung: h.rung, ...(instance ? { instance } : {}) });
    onSelect({ kind: "ref", ref: selection.ref, where: selection.where, rung: h.rung });
  };

  return (
    <div className="panel-stack">
      <section>
        <div className="eyebrow">{info.scope}</div>
        <h2 className="ref-title mono">{stripScope(info.key)}</h2>
        {info.symbol && info.symbol !== info.key && info.symbol !== stripScope(info.key) ? (
          <div className="ref-symbol mono">{info.symbol}</div>
        ) : null}
        {info.description ? <p className="ref-desc">{info.description}</p> : <p className="muted">No description.</p>}
        <div className="facts">
          {info.dataType ? (
            <div className="fact">
              <span>Type</span>
              <span className="mono">{info.dataType}</span>
            </div>
          ) : null}
          {info.aliasFor ? (
            <div className="fact">
              <span>Alias for</span>
              <button type="button" className="link mono" onClick={() => onSelect({ kind: "ref", ref: info.aliasFor!, where: selection.where })}>
                {info.aliasFor}
              </button>
            </div>
          ) : null}
          {io ? (
            <div className="fact">
              <span>{io.kind === "input" ? "Input" : "Output"}</span>
              <span>{io.location}</span>
            </div>
          ) : null}
          {info.instancePath ? (
            <div className="fact">
              <span>Instance</span>
              <span className="mono">{stripScope(info.instancePath)}</span>
            </div>
          ) : null}
          {info.forced ? (
            <div className="fact">
              <span>Force</span>
              <span className="chip danger">Forced {info.forced.toUpperCase()}</span>
            </div>
          ) : null}
          {baseInfo && baseInfo.description && baseInfo.description !== info.description ? (
            <div className="fact">
              <span>Part of</span>
              <button type="button" className="link mono" onClick={() => onSelect({ kind: "ref", ref: baseRef, where: selection.where })}>
                {baseRef}
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <h3 className="section-label">Saved value</h3>
        {info.hasValue && info.value !== undefined ? (
          <>
            <div className="value-row">
              <ValueView value={info.value} />
              <button
                type="button"
                className="btn small"
                onClick={() =>
                  onNavigate({
                    view: "troubleshoot",
                    ref: selection.ref,
                    where: selection.where.instance
                      ? { kind: selection.where.kind, owner: selection.where.owner, instance: selection.where.instance }
                      : { kind: selection.where.kind, owner: selection.where.owner },
                  })
                }
              >
                {typeof info.value === "boolean" ? `Why is it ${info.value ? "ON" : "OFF"}?` : "What writes it?"}
              </button>
            </div>
            <p className="muted small">As saved in the export file — not a live reading.</p>
          </>
        ) : (
          <p className="muted small">
            {info.scope.startsWith("AOI") && selection.where.kind === "aoi"
              ? "This is a parameter or local tag inside the AOI definition. Open the logic through an instance to see its values."
              : "No saved value for this in the export."}
          </p>
        )}
      </section>

      {onDrawings.length ? (
        <section>
          <h3 className="section-label">
            On drawings <span className="count">{onDrawings.length}</span>
          </h3>
          <ul className="hits">
            {onDrawings.map((h, i) => (
              <li key={i}>
                <button type="button" className="hit" onClick={() => onNavigate({ view: "drawings", id: h.attachmentId, page: h.page })}>
                  <span className="mn">p.{h.page}</span>
                  <span className="hit-loc">{h.name}</span>
                  <span className="hit-addr">{h.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3 className="section-label">
          Written by <span className="count">{writes.length}</span>
        </h3>
        <HitList hits={writes} index={index} onJump={jump} empty="Nothing in the logic writes this." />
        <h3 className="section-label">
          Read by <span className="count">{reads.length}</span>
        </h3>
        <HitList hits={reads} index={index} onJump={jump} empty="Nothing in the logic reads this." />
      </section>

      <section>
        <h3 className="section-label">Ask AI</h3>
        <AskAi
          cacheKey={`tag|${info.key}|${JSON.stringify(selection.where.instance ?? null)}`}
          label="Explain this signal"
          what="this tag's description and value, plus the rungs that write it"
          buildContext={() => tagContext(index, selection.ref, selection.where)}
        />
      </section>
    </div>
  );
}

function HitList({
  hits,
  index,
  onJump,
  empty,
}: {
  hits: CrossReferenceHit[];
  index: ProjectIndex;
  onJump: (h: CrossReferenceHit) => void;
  empty: string;
}) {
  if (hits.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <ul className="hits">
      {hits.slice(0, 200).map((h, i) => (
        <li key={i}>
          <button type="button" className="hit" onClick={() => onJump(h)}>
            <span className={`mn ${h.access}`}>{h.mnemonic}</span>
            <span className="hit-loc">
              {locLabel(index, h)} <span className="muted">· rung {h.rung}</span>
            </span>
            <span className="hit-addr mono">{h.address}</span>
          </button>
        </li>
      ))}
      {hits.length > 200 ? <li className="muted small">…{hits.length - 200} more</li> : null}
    </ul>
  );
}

function BlockerList({
  blockers,
  index,
  where,
  onPick,
}: {
  blockers: Blocker[];
  index: ProjectIndex;
  where: RoutineScope;
  onPick: (ref: string) => void;
}) {
  return (
    <ul className="blockers">
      {blockers.map((b, i) => {
        if (b.kind === "instr") {
          const d = describeBlocker(b.node, b.state, index, where);
          return (
            <li key={i}>
              <button type="button" className="blocker" disabled={!d.ref} onClick={() => d.ref && onPick(d.ref)}>
                <Icon name="x" size={13} className="x" />
                {d.text}
              </button>
            </li>
          );
        }
        return (
          <li key={i} className="anyof">
            <span className="muted small">One of these must be true:</span>
            {b.branches.map((br, k) => (
              <div key={k} className="anyof-branch">
                <span className="muted small">Branch {k + 1}</span>
                {br.length ? (
                  <BlockerList blockers={br} index={index} where={where} onPick={onPick} />
                ) : (
                  <span className="muted small"> — state unknown</span>
                )}
              </div>
            ))}
          </li>
        );
      })}
    </ul>
  );
}

function outputLabel(node: Extract<LadderNode, { kind: "instruction" }>): string {
  return `${node.mnemonic} ${node.operands[0] ?? ""}`.trim();
}

function RungPanel({
  index,
  where,
  rung: rungIndex,
  onSelect,
  onNavigate,
}: {
  index: ProjectIndex;
  where: RoutineScope;
  rung: number;
  onSelect: (sel: Selection) => void;
  onNavigate: (loc: Location) => void;
}) {
  const rung = index.routine(where)?.rungs.find((r) => r.index === rungIndex);
  const ev = useMemo(() => (rung?.ladder ? evaluate(rung.ladder, index, where) : null), [rung, index, where]);
  if (!rung) return <p className="muted">Rung not found.</p>;
  const tree = explainOutputs(rung, index, where);
  const comment = tidyComment(rung.comment);
  const instructions = instructionsOf(rung.ladder);
  const pick = (ref: string) => onSelect({ kind: "ref", ref, where, rung: rung.index });
  const status = ev?.out;

  return (
    <div className="panel-stack">
      <section>
        <div className="eyebrow">
          {where.owner}
          {index.isLogix ? ` › ${where.routine}` : ""}
          {where.instance ? ` · instance ${where.instance.tag}` : ""}
        </div>
        <div className="rung-head">
          <h2 className="ref-title">Rung {rung.index}</h2>
          {status === true ? (
            <span className="chip on">True in saved values</span>
          ) : status === false ? (
            <span className="chip">False in saved values</span>
          ) : (
            <span className="chip warn">State unknown</span>
          )}
        </div>
        {comment ? <p className="ref-desc pre">{comment}</p> : <p className="muted small">No rung comment.</p>}
      </section>

      <section>
        <h3 className="section-label">What it does</h3>
        <OutputTree root={tree} />
      </section>

      {ev && ev.outputs.length ? (
        <section>
          <h3 className="section-label">
            Outputs <span className="count">{ev.outputs.length}</span>
          </h3>
          <ul className="outputs">
            {ev.outputs.map((o, i) => {
              const st = ev.states.get(o)?.in;
              const ref = o.operands[0] && !isConstant(o.operands[0]) ? o.operands[0] : undefined;
              const desc = ref ? shortName(index, ref, where) : undefined;
              const blockers = st === false ? ev.blockers(o) : [];
              return (
                <li key={i} className="output">
                  <div className="output-head">
                    <span className={`state-dot ${st === true ? "on" : st === false ? "off" : "unknown"}`} aria-hidden />
                    <button type="button" className="link mono output-name" disabled={!ref} onClick={() => ref && pick(ref)}>
                      {outputLabel(o)}
                    </button>
                    <span className="muted small">{st === true ? "gets power" : st === false ? "no power" : "unknown"}</span>
                  </div>
                  {desc && desc !== ref ? <div className="muted small output-desc">{desc}</div> : null}
                  {blockers.length ? (
                    <div className="blocked-by">
                      <span className="small">Blocked by:</span>
                      <BlockerList blockers={blockers} index={index} where={where} onPick={pick} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="muted small">Worked out from the values saved in the export — a snapshot, not live.</p>
        </section>
      ) : null}

      <section>
        <h3 className="section-label">
          Instructions <span className="count">{instructions.length}</span>
        </h3>
        <ul className="instr-list">
          {instructions.map((ins, i) => {
            const info = instructionInfo(ins.mnemonic);
            const aoi = info ? undefined : index.aoi(ins.mnemonic);
            const names = aoi
              ? [aoi.name, ...aoi.parameters.filter((p) => p.required || p.usage?.toLowerCase() === "inout").map((p) => p.name)]
              : index.isLogix && info?.category === "timer" && ins.mnemonic !== "RES"
                ? ["Timer", "Preset", "Accum"]
                : (info?.operands ?? []);
            const help = aoi ? aoi.description?.split("\n")[0] : instructionHelp(ins.mnemonic);
            const st = ev?.states.get(ins);
            return (
              <li key={i}>
                <div className="instr-head">
                  <span className="mn">{ins.mnemonic}</span>
                  {st?.cond === true && info && !info.output ? <span className="chip on small">true</span> : null}
                  {st?.cond === false ? <span className="chip small">false</span> : null}
                  {aoi && !aoi.encoded && aoi.routines.length && ins.operands[0] ? (
                    <button
                      type="button"
                      className="link small"
                      onClick={() =>
                        onNavigate({
                          view: "routine",
                          ref: { kind: "aoi", owner: aoi.name, routine: (aoi.routines.find((r) => r.name.toUpperCase() === "LOGIC") ?? aoi.routines[0]!).name },
                          instance: {
                            tag: ins.operands[0]!,
                            caller: where.instance ? { kind: where.kind, owner: where.owner, instance: where.instance } : { kind: where.kind, owner: where.owner },
                          },
                        })
                      }
                    >
                      Open logic →
                    </button>
                  ) : null}
                </div>
                {help ? <p className="instr-help">{help}</p> : null}
                {ins.operands.map((op, k) => {
                  const isRef = isTagOperand(op, index.isLogix ? "logix" : "classic");
                  const r = isRef ? index.resolve(op, where) : undefined;
                  return (
                    <button key={k} type="button" className="operand" disabled={!isRef} onClick={() => isRef && pick(op)}>
                      <span className="op-line">
                        {names[k] ? <span className="op-name">{names[k]}</span> : null}
                        <span className="mono op">{op}</span>
                      </span>
                      {r?.hasValue && typeof r.value !== "object" ? (
                        <span className={`mono val ${typeof r.value === "boolean" ? (r.value ? "on" : "off") : ""}`}>
                          {formatValue(r.value)}
                        </span>
                      ) : null}
                      {r?.description ? <span className="op-desc">{r.description.replace(/\s*\n\s*/g, " ")}</span> : null}
                    </button>
                  );
                })}
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h3 className="section-label">Ask AI</h3>
        <AskAi
          cacheKey={`rung|${where.kind}|${where.owner}|${where.routine}|${rung.index}|${JSON.stringify(where.instance ?? null)}`}
          label="Explain this rung"
          what="this rung's logic, comment, and its tags' descriptions and saved values"
          buildContext={() => rungContext(index, where, rung, ev)}
        />
      </section>

      <section>
        <h3 className="section-label">Raw rung text</h3>
        <pre className="raw mono">{rung.text}</pre>
      </section>
    </div>
  );
}
