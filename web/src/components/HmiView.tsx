import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { HmiObject, HmiProject, HmiScreen, HmiState } from "@core/model/types";
import { formatValue, type ProjectIndex, type Scope } from "@core/query/index";
import { ACCESS_LABEL, formatHmiAddress, hmiAlarms, hmiLinksCached, objectLabel, type HmiAlarmView, type HmiLinks } from "@core/logic/hmi";
import { contrastText } from "@core/importers/hmi/style";
import type { Location, Selection } from "../lib/nav";
import { FilePicker, EXPORT_ACCEPT, PANEL_ACCEPT } from "./FilePicker";
import { Icon } from "./Icon";

type Nav = { onNavigate: (loc: Location) => void; onSelect: (sel: Selection) => void };
type HmiLocation = Extract<Location, { view: "hmi" }>;

const CONTROLLER: Scope = { kind: "program", owner: "" };


/** Words for an object type: MomentaryPushButton → Momentary push button. */
function typeWords(type: string): string {
  const w = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function HmiView({
  index,
  location,
  machineName,
  onAddFiles,
  onNavigate,
  onSelect,
}: { index: ProjectIndex; location: HmiLocation; machineName: string; onAddFiles: (files: File[]) => void } & Nav) {
  const panels = index.project.hmi ?? [];
  const [panelIdx, setPanelIdx] = useState(0);
  const links = useMemo(() => hmiLinksCached(index), [index]);
  const alarms = useMemo(() => hmiAlarms(index, links), [index, links]);
  const hmi = panels[Math.min(panelIdx, panels.length - 1)];
  const hasLogic = index.project.programs.length > 0;
  const tab = location.tab ?? "screens";

  if (!hmi) {
    return (
      <div className="view">
        <header className="view-head">
          <div className="eyebrow">Operator panel</div>
          <h1 className="view-title">{machineName} has no panel file yet</h1>
          <p className="view-desc">
            Add the PanelView Plus runtime file (.MER — it can be copied off the panel) or the FactoryTalk View project archive (.APA). You&apos;ll see every screen,
            which PLC bits each button writes and each indicator shows, and the alarm messages with the rungs that raise them.
          </p>
        </header>
        <FilePicker className="btn primary" accept={PANEL_ACCEPT} multiple={false} onFiles={onAddFiles}>
          <Icon name="panel" size={16} /> Add the panel&apos;s .MER or .APA
        </FilePicker>
      </div>
    );
  }

  const panelAlarms = alarms.filter((a) => a.application === hmi.application);
  return (
    <div className="view hmi-view">
      <header className="view-head">
        <div className="eyebrow">Operator panel</div>
        <div className="view-title-row">
          <h1 className="view-title">{hmi.application}</h1>
          <span className="view-meta">
            {hmi.screens.length} screens · {hmi.messages.length} alarm messages
          </span>
        </div>
        <p className="view-desc">
          {hmi.format === "mer" ? "PanelView Plus runtime file" : "FactoryTalk View project archive"} <span className="mono">{hmi.file}</span>
          {hmi.shortcuts.length ? (
            <>
              {" "}
              · talks to{" "}
              {hmi.shortcuts.map((s, i) => (
                <span key={s.name}>
                  {i ? ", " : ""}
                  <strong>{s.name}</strong>
                  {s.address ? <span className="mono"> {s.address}</span> : null}
                  {s.deviceType ? <span className="muted"> ({s.deviceType})</span> : null}
                  {hasLogic && links.local.has(s.name.toLowerCase()) ? <span className="chip small on-chip">this PLC</span> : null}
                </span>
              ))}
            </>
          ) : null}
        </p>
        {!hasLogic ? (
          <div className="notice small hmi-notice">
            <span>Add this machine&apos;s PLC export to link each button and alarm message to the rungs behind it.</span>
            <FilePicker className="btn small" accept={EXPORT_ACCEPT} onFiles={onAddFiles}>
              Add PLC export
            </FilePicker>
          </div>
        ) : null}
        <div className="toolbar">
          {panels.length > 1 ? (
            <select className="input" value={panelIdx} onChange={(e) => setPanelIdx(Number(e.target.value))} aria-label="Panel">
              {panels.map((p, i) => (
                <option key={p.file} value={i}>
                  {p.application}
                </option>
              ))}
            </select>
          ) : null}
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "screens"} className={`seg-btn${tab === "screens" ? " on" : ""}`} onClick={() => onNavigate({ view: "hmi" })}>
              Screens
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "alarms"}
              className={`seg-btn${tab === "alarms" ? " on" : ""}`}
              onClick={() => onNavigate({ view: "hmi", tab: "alarms" })}
            >
              Alarm messages
            </button>
          </div>
        </div>
      </header>
      {tab === "alarms" ? (
        <AlarmMessages hmi={hmi} alarms={panelAlarms} index={index} hasLogic={hasLogic} onNavigate={onNavigate} onSelect={onSelect} />
      ) : (
        <Screens hmi={hmi} links={links} index={index} location={location} hasLogic={hasLogic} onNavigate={onNavigate} onSelect={onSelect} />
      )}
      {hmi.warnings.length ? (
        <details className="muted small hmi-warnings">
          <summary>{hmi.warnings.length} things couldn&apos;t be read</summary>
          <ul>
            {hmi.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/* --------------------------------- screens -------------------------------- */

function Screens({
  hmi,
  links,
  index,
  location,
  hasLogic,
  onNavigate,
  onSelect,
}: { hmi: HmiProject; links: HmiLinks; index: ProjectIndex; location: HmiLocation; hasLogic: boolean } & Nav) {
  const [filter, setFilter] = useState("");
  const screen =
    hmi.screens.find((s) => s.name.toLowerCase() === location.screen?.toLowerCase()) ??
    hmi.screens.find((s) => s.name === hmi.startup) ??
    hmi.screens.find((s) => /\bmain\b/i.test(s.name) && !s.name.startsWith("[")) ??
    hmi.screens.find((s) => !s.name.startsWith("[")) ??
    hmi.screens[0];
  const [picked, setPicked] = useState<string | undefined>(location.object);
  const [plain, setPlain] = useState(() => {
    try {
      return localStorage.getItem("clt-hmi-look") === "plain";
    } catch {
      return false;
    }
  });
  const choosePlain = (next: boolean) => {
    setPlain(next);
    try {
      localStorage.setItem("clt-hmi-look", next ? "plain" : "panel");
    } catch {
      // storage blocked: keep it for this visit
    }
  };
  useEffect(() => setPicked(location.object), [location.object, location.screen]);

  const q = filter.trim().toLowerCase();
  const shown = hmi.screens.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.objects.some((o) => o.captions.some((c) => c.toLowerCase().includes(q))),
  );
  const openedFrom = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const s of hmi.screens) for (const o of s.objects) if (o.goto) (m.get(o.goto) ?? m.set(o.goto, new Set()).get(o.goto)!).add(s.name);
    return m;
  }, [hmi]);

  if (!screen) return <p className="muted">No screens could be read from this file.</p>;
  const object = screen.objects.find((o) => o.name === picked);
  const isLocal = (shortcut?: string) => hasLogic && !!shortcut && links.local.has(shortcut.toLowerCase());
  const readInfo = (o: HmiObject) => {
    const r = o.connections.find((c) => c.access === "read" || c.access === "readwrite")?.refs[0];
    if (!r || !isLocal(r.shortcut)) return undefined;
    const info = index.resolve(r.address, CONTROLLER);
    return info.hasValue ? info : undefined;
  };
  const values: SketchValues = {
    text: (o) => {
      const info = readInfo(o);
      return info ? formatValue(info.value, 12) : undefined;
    },
    number: (o) => {
      const v = readInfo(o)?.value;
      return typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : undefined;
    },
  };
  const controls = screen.objects.filter((o) => o.kind === "button" || o.kind === "input" || o.kind === "indicator" || o.kind === "display");
  const from = [...(openedFrom.get(screen.name) ?? [])];

  return (
    <div className="hmi-layout">
      <nav className="hmi-list" aria-label="Screens">
        <input className="input" placeholder="Find a screen or button…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select
          className="input hmi-list-select"
          value={screen.name}
          onChange={(e) => onNavigate({ view: "hmi", screen: e.target.value })}
          aria-label="Screen"
        >
          {shown.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <ul className="plain hmi-list-items">
          {shown.map((s) => (
            <li key={s.name}>
              <button
                type="button"
                className={`hmi-list-item${s.name === screen.name ? " on" : ""}`}
                onClick={() => onNavigate({ view: "hmi", screen: s.name })}
              >
                <span>{s.name}</span>
                <span className="muted small">{s.objects.filter((o) => o.kind === "button" || o.kind === "input").length || ""}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <section className="hmi-main">
        <div className="hmi-screen-head">
          <h2 className="card-title">{screen.name}</h2>
          {screen.name === hmi.startup ? <span className="chip small">start screen</span> : null}
          <div className="seg hmi-look" role="group" aria-label="Drawing style">
            <button type="button" className={`seg-btn${!plain ? " on" : ""}`} onClick={() => choosePlain(false)}>
              Panel look
            </button>
            <button type="button" className={`seg-btn${plain ? " on" : ""}`} onClick={() => choosePlain(true)}>
              Plain
            </button>
          </div>
          <span className="muted small">
            {screen.width}×{screen.height}
            {from.length ? (
              <>
                {" "}
                · opened from{" "}
                {from.slice(0, 4).map((f, i) => (
                  <span key={f}>
                    {i ? ", " : ""}
                    <button type="button" className="link" onClick={() => onNavigate({ view: "hmi", screen: f })}>
                      {f}
                    </button>
                  </span>
                ))}
                {from.length > 4 ? ` and ${from.length - 4} more` : ""}
              </>
            ) : null}
          </span>
        </div>
        <ScreenPreview screen={screen} images={hmi.images} selected={object?.name} onPick={(o) => setPicked(o.name)} values={values} plain={plain} />
        <p className="muted small hmi-caveat">
          {plain
            ? "Plain sketch: buttons, indicators and text in their real positions."
            : "Drawn from the panel file: positions, colours, outlines, pictures and fonts. Button and indicator text colours are picked for contrast, and animations aren't shown."}{" "}
          {hasLogic ? "Indicators show the state for the saved PLC values." : "Indicators show their first state (add the PLC export to show saved values)."}
        </p>
        {object ? (
          <ObjectDetail
            object={object}
            screen={screen}
            index={index}
            isLocal={isLocal}
            onNavigate={onNavigate}
            onSelect={onSelect}
            onClose={() => setPicked(undefined)}
          />
        ) : null}
        {controls.length ? (
          <div className="table-wrap">
            <table className="table hmi-table">
              <thead>
                <tr>
                  <th>On the screen</th>
                  <th>Type</th>
                  <th>PLC</th>
                </tr>
              </thead>
              <tbody>
                {controls.map((o) => (
                  <tr key={o.name} className={`clickable${o.name === object?.name ? " selected" : ""}`} onClick={() => setPicked(o.name)}>
                    <td data-label="On the screen">{objectLabel(o)}</td>
                    <td data-label="Type" className="muted small">
                      {typeWords(o.type)}
                    </td>
                    <td data-label="PLC" className="mono small">
                      {o.goto ? <span className="muted">→ {o.goto} </span> : null}
                      {uniqueRefs(o).map((r) => (
                        <span key={r.label} className={`hmi-ref access-${r.access}`} title={ACCESS_LABEL[r.access]}>
                          {r.label}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function uniqueRefs(o: HmiObject) {
  const out: { label: string; access: HmiObject["connections"][number]["access"] }[] = [];
  for (const c of o.connections) {
    if (c.access === "animation") continue;
    for (const r of c.refs) if (!out.some((x) => x.label === r.address)) out.push({ label: r.address, access: c.access });
  }
  return out;
}

function ObjectDetail({
  object,
  screen,
  index,
  isLocal,
  onNavigate,
  onSelect,
  onClose,
}: {
  object: HmiObject;
  screen: HmiScreen;
  index: ProjectIndex;
  isLocal: (shortcut?: string) => boolean;
  onClose: () => void;
} & Nav) {
  const select = (address: string) => onSelect({ kind: "ref", ref: address, where: { ...CONTROLLER, routine: "" } });
  const rows = object.connections.flatMap((c) => c.refs.map((r) => ({ c, r })));
  return (
    <article className="card hmi-detail">
      <div className="hmi-detail-head">
        <div>
          <h3 className="card-title">{objectLabel(object)}</h3>
          <div className="muted small">
            {typeWords(object.type)} · <span className="mono">{object.name}</span> on {screen.name}
          </div>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      {object.captions.length > 1 ? (
        <>
          <h4 className="section-label">Captions / states</h4>
          <ol className="hmi-states small">
            {object.captions.map((c, i) => (
              <li key={i}>{c.replace(/\n/g, " ")}</li>
            ))}
          </ol>
        </>
      ) : null}
      {object.goto ? (
        <p className="small">
          Opens{" "}
          <button type="button" className="link" onClick={() => onNavigate({ view: "hmi", screen: object.goto! })}>
            {object.goto}
          </button>
        </p>
      ) : null}
      {rows.length ? (
        <>
          <h4 className="section-label">PLC connections</h4>
          <ul className="plain hmi-conns">
            {rows.map(({ c, r }, i) => {
              const local = isLocal(r.shortcut);
              const info = local ? index.resolve(r.address, CONTROLLER) : undefined;
              const desc = info ? [info.symbol, info.description].filter(Boolean).join(" — ") : "";
              return (
                <li key={i} className="hmi-conn">
                  <span className={`chip small access-${c.access}`}>{ACCESS_LABEL[c.access]}</span>
                  {local ? (
                    <button type="button" className="link mono" onClick={() => select(r.address)} title="Show in the inspector: where the logic uses it">
                      {r.address}
                    </button>
                  ) : (
                    <span className="mono">{formatHmiAddress(r)}</span>
                  )}
                  {info?.hasValue ? <span className="muted small"> = {formatValue(info.value, 16)}</span> : null}
                  {desc ? <span className="muted small"> {desc}</span> : null}
                  {c.expr.replace(/::\[[^\]]+\]/g, "") !== r.address ? <div className="muted small mono hmi-expr">{c.expr}</div> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : !object.goto ? (
        <p className="muted small">No PLC connection.</p>
      ) : null}
    </article>
  );
}

/* ------------------------------ screen sketch ----------------------------- */

/** Saved (or live) values the sketch shows: a number picks the state, text fills displays. */
export interface SketchValues {
  number: (o: HmiObject) => number | undefined;
  text: (o: HmiObject) => string | undefined;
}

/** Fit text in a box: word-wrap and shrink until it fits. */
function fitText(text: string, w: number, h: number, max: number): { size: number; lines: string[] } {
  const paras = text.split("\n");
  for (let size = max; size >= 6; size -= 1) {
    const per = Math.max(1, Math.floor((w - 6) / (size * 0.56)));
    const lines: string[] = [];
    for (const p of paras) {
      let line = "";
      for (const word of p.split(/\s+/)) {
        if (!word) continue;
        if (!line) line = word;
        else if ((line + " " + word).length <= per) line += ` ${word}`;
        else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    if (lines.length * size * 1.18 <= h - 2 && lines.every((l) => l.length <= per)) return { size, lines };
  }
  const size = 6;
  const per = Math.max(1, Math.floor((w - 6) / (size * 0.56)));
  return { size, lines: [text.replace(/\s+/g, " ").slice(0, per)] };
}

function Label({
  rect,
  text,
  max,
  anchor,
  cls,
  color,
  bold,
}: {
  rect: [number, number, number, number];
  text: string;
  max: number;
  anchor: "middle" | "start" | "auto";
  cls: string;
  color?: string | undefined;
  bold?: boolean | undefined;
}) {
  const [l, t, r, b] = rect;
  const w = r - l;
  const h = b - t;
  const { size, lines } = fitText(text, w, h, max);
  const lh = size * 1.18;
  const y0 = t + h / 2 - ((lines.length - 1) * lh) / 2;
  // Short labels in a wide box read as centred; paragraphs start at the left.
  const longest = Math.max(...lines.map((x) => x.length));
  const side = anchor === "auto" ? (lines.length <= 2 && longest * size * 0.56 < w * 0.7 ? "middle" : "start") : anchor;
  const x = side === "middle" ? l + w / 2 : l + 3;
  const style = { ...(color ? { fill: color } : {}), ...(bold === undefined ? {} : { fontWeight: bold ? 700 : 400 }) };
  return (
    <text className={cls} fontSize={size} textAnchor={side} dominantBaseline="central" style={style}>
      {lines.map((line, i) => (
        <tspan key={i} x={x} y={y0 + i * lh}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** The state an object shows for its value (the first state when there's no value). */
function stateOf(o: HmiObject, values: SketchValues): HmiState | undefined {
  const states = o.states;
  if (!states?.length) return undefined;
  const n = values.number(o);
  if (n === undefined) return states[0];
  if (o.kind === "indicator") return states.find((st) => st.value === n) ?? states[0];
  return states[n ? 1 : 0] ?? states[0];
}

/** Filled box with FactoryTalk's raised border: highlight top-left, shadow bottom-right. */
function Raised({ rect, look }: { rect: [number, number, number, number]; look: { fill?: string | undefined; border?: string | undefined; highlight?: string | undefined; shadow?: string | undefined } }) {
  const [l, t, r, b] = rect;
  const w = Math.max(1, r - l);
  const h = Math.max(1, b - t);
  const inset = 1.5;
  return (
    <>
      <rect x={l} y={t} width={w} height={h} style={{ fill: look.fill ?? "none", stroke: look.border ?? "none", strokeWidth: 1 }} />
      {look.highlight && look.shadow && w > 6 && h > 6 ? (
        <>
          <path d={`M${l + inset} ${b - inset} V${t + inset} H${r - inset}`} style={{ fill: "none", stroke: look.highlight, strokeWidth: 2 }} />
          <path d={`M${l + inset} ${b - inset} H${r - inset} V${t + inset}`} style={{ fill: "none", stroke: look.shadow, strokeWidth: 2 }} />
        </>
      ) : null}
    </>
  );
}

function ScreenPreview({
  screen,
  images,
  selected,
  onPick,
  values,
  plain,
}: {
  screen: HmiScreen;
  images: HmiProject["images"];
  selected?: string | undefined;
  onPick: (o: HmiObject) => void;
  values: SketchValues;
  plain: boolean;
}) {
  // Objects are stored front to back: draw from the back.
  const objects = screen.objects.filter((o) => o.rect && o.kind !== "group").reverse();
  const sel = screen.objects.find((o) => o.name === selected);
  return (
    <div className={`hmi-screen-wrap${plain ? "" : " looks"}`}>
      <svg className="hmi-screen" viewBox={`0 0 ${screen.width} ${screen.height}`} role="img" aria-label={`Drawing of the ${screen.name} screen`}>
        <rect className="hmi-bg" x={0} y={0} width={screen.width} height={screen.height} style={!plain && screen.background ? { fill: screen.background } : undefined} />
        {objects.map((o) => {
          const rect = o.rect!;
          const body = plain ? plainBody(o, rect, values) : lookBody(o, rect, values, images) ?? plainBody(o, rect, values);
          const clickable = o.kind !== "shape" || !!o.image;
          return (
            <g
              key={o.name}
              className={`hmi-o${clickable ? " clickable" : ""}`}
              onClick={clickable ? () => onPick(o) : undefined}
              role={clickable ? "button" : undefined}
              aria-label={clickable ? objectLabel(o) : undefined}
            >
              {body}
              {clickable ? <title>{`${objectLabel(o)} (${typeWords(o.type)})`}</title> : null}
            </g>
          );
        })}
        {sel?.rect ? (
          <rect className="hmi-o-sel" x={sel.rect[0]} y={sel.rect[1]} width={Math.max(1, sel.rect[2] - sel.rect[0])} height={Math.max(1, sel.rect[3] - sel.rect[1])} />
        ) : null}
      </svg>
    </div>
  );
}

/** The object drawn with the colours, fonts, outlines and pictures from the file. */
function lookBody(o: HmiObject, rect: [number, number, number, number], values: SketchValues, images: HmiProject["images"]): ReactNode | undefined {
  const [l, t, r, b] = rect;
  if (o.image && images?.[o.image]) {
    const img = images[o.image]!;
    return <image href={`data:${img.mime};base64,${img.data}`} x={l} y={t} width={Math.max(1, r - l)} height={Math.max(1, b - t)} preserveAspectRatio="none" />;
  }
  if (o.points) {
    const pts = o.points.map(([x, y]) => `${x},${y}`).join(" ");
    const style = { fill: o.fill ?? "none", stroke: o.border ?? "#808080", strokeWidth: o.lineWidth ?? 1 };
    return o.closed ? <polygon points={pts} style={style} /> : <polyline points={pts} style={{ ...style, fill: "none" }} />;
  }
  if (o.kind === "text" && o.text) {
    const caption = o.captions[0] ?? "";
    return (
      <>
        {o.text.back ? <rect x={l} y={t} width={Math.max(1, r - l)} height={Math.max(1, b - t)} style={{ fill: o.text.back }} /> : null}
        {caption ? <Label rect={rect} text={caption} max={o.text.size ?? 13} anchor="auto" cls="hmi-t-text" color={o.text.color} bold={o.text.bold} /> : null}
      </>
    );
  }
  const state = stateOf(o, values);
  if (state?.fill) {
    const caption = state.caption && state.caption !== "Error" ? state.caption : o.goto ?? "";
    return (
      <>
        <Raised rect={rect} look={state} />
        {caption ? <Label rect={rect} text={caption} max={15} anchor="middle" cls="hmi-t-button" color={contrastText(state.fill)} /> : null}
      </>
    );
  }
  if (o.fill) {
    const v = o.kind === "display" || o.kind === "input" ? values.text(o) ?? "" : "";
    return (
      <>
        <Raised rect={rect} look={o} />
        {v ? <Label rect={rect} text={v} max={14} anchor="middle" cls="hmi-t-display" color={contrastText(o.fill)} /> : null}
      </>
    );
  }
  return undefined;
}

/** Neutral sketch: shapes by kind, captions, values. */
function plainBody(o: HmiObject, rect: [number, number, number, number], values: SketchValues): ReactNode {
  const [l, t, r, b] = rect;
  const common = { x: l, y: t, width: Math.max(1, r - l), height: Math.max(1, b - t) };
  const state = stateOf(o, values);
  const caption = (state?.caption && state.caption !== "Error" ? state.caption : undefined) ?? o.captions[0] ?? "";
  switch (o.kind) {
    case "shape":
      return o.points ? (
        o.closed ? (
          <polygon points={o.points.map(([x, y]) => `${x},${y}`).join(" ")} className="hmi-o-shape" />
        ) : (
          <polyline points={o.points.map(([x, y]) => `${x},${y}`).join(" ")} className="hmi-o-shape" />
        )
      ) : (
        <rect {...common} className="hmi-o-shape" />
      );
    case "text":
      return caption ? <Label rect={rect} text={caption} max={16} anchor="start" cls="hmi-t-text" /> : null;
    case "button":
    case "input":
      return (
        <>
          <rect {...common} rx={4} className={`hmi-o-button${o.kind === "input" ? " input" : ""}`} />
          <Label rect={rect} text={caption || (o.goto ?? typeWords(o.type))} max={15} anchor="middle" cls="hmi-t-button" />
        </>
      );
    case "indicator":
      return (
        <>
          <rect {...common} rx={2} className="hmi-o-indicator" />
          {caption ? <Label rect={rect} text={caption} max={14} anchor="middle" cls="hmi-t-indicator" /> : null}
        </>
      );
    case "display":
      return (
        <>
          <rect {...common} className="hmi-o-display" />
          <Label rect={rect} text={values.text(o) ?? caption ?? "###"} max={14} anchor="middle" cls="hmi-t-display" />
        </>
      );
    default:
      return (
        <>
          <rect {...common} className="hmi-o-other" />
          <Label rect={rect} text={typeWords(o.type)} max={12} anchor="middle" cls="hmi-t-other" />
        </>
      );
  }
}

/* ------------------------------ alarm messages ---------------------------- */

function AlarmMessages({
  hmi,
  alarms,
  index,
  hasLogic,
  onNavigate,
  onSelect,
}: { hmi: HmiProject; alarms: HmiAlarmView[]; index: ProjectIndex; hasLogic: boolean } & Nav) {
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(150);
  const q = filter.trim().toLowerCase();
  const shown = alarms.filter((a) => !q || a.text.toLowerCase().includes(q) || String(a.value) === q);
  const found = alarms.filter((a) => a.raisers.length).length;

  const jump = (a: HmiAlarmView, i: number) => {
    const r = a.raisers[i]!;
    onNavigate({ view: "routine", ref: r.where, rung: r.rung });
    const ref = a.trigger?.refs[0]?.address;
    if (ref) onSelect({ kind: "ref", ref, where: { ...r.where }, rung: r.rung });
  };

  return (
    <section className="hmi-alarms">
      <div className="card">
        {hmi.triggers.length ? (
          <p className="small">
            {hmi.triggers.map((t, i) => (
              <span key={t.index}>
                {i ? <br /> : null}
                The panel shows message <em>n</em> when the PLC puts <em>n</em> into{" "}
                <strong className="mono">{t.refs[0] ? formatHmiAddress(t.refs[0]) : t.expr}</strong>
                <span className="muted"> (trigger {t.label})</span>.
              </span>
            ))}
          </p>
        ) : (
          <p className="small muted">No alarm trigger was found in the panel file.</p>
        )}
        <p className="muted small">
          {hasLogic
            ? `Found the rung that sets the number for ${found} of ${alarms.length} messages. The rest are set some other way (math, a copy from another word) or not used.`
            : "Add the PLC export to see which rung raises each message."}
        </p>
      </div>
      <div className="toolbar">
        <input className="input grow" placeholder="Find a message…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="table-wrap">
        <table className="table hmi-msg-table">
          <thead>
            <tr>
              <th>No.</th>
              <th>Message on the panel</th>
              {hasLogic ? <th>Raised by</th> : null}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((a) => (
              <tr key={`${a.trigger?.index ?? 0}-${a.value}`}>
                <td data-label="No." className="mono">
                  {a.value}
                </td>
                <td data-label="Message">{a.text}</td>
                {hasLogic ? (
                  <td data-label="Raised by" className="small">
                    {a.raisers.length ? (
                      a.raisers.slice(0, 4).map((r, i) => (
                        <button key={i} type="button" className="link hmi-raiser" onClick={() => jump(a, i)} title={r.detail}>
                          {routineLabel(index, r.where)} rung {r.rung}
                        </button>
                      ))
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > limit ? (
        <button type="button" className="btn" onClick={() => setLimit(shown.length)}>
          Show all {shown.length}
        </button>
      ) : null}
    </section>
  );
}

function routineLabel(index: ProjectIndex, where: { kind: string; owner: string; routine: string }): string {
  if (index.isLogix) return `${where.owner} / ${where.routine}`;
  const p = index.project.programs.find((x) => x.name === where.owner);
  return p?.number !== undefined ? `File ${p.number} ${where.routine}` : where.routine;
}
