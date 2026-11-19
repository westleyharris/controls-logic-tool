import { useEffect, useMemo, useState } from "react";
import type { ProjectIndex, Scope } from "@core/query/index";
import { alarmHandbook, buildChecklist, CATEGORY_ORDER, CATEGORY_TITLE, type CheckItem } from "@core/logic/checklist";
import { groupByEndpoint, type CommLink, type MachineComms } from "@core/logic/connectivity";
import type { AlarmEntry, IoGroup } from "@core/logic/overview";
import type { Location, Selection } from "../lib/nav";
import type { SearchItem } from "../lib/search";
import { useKv } from "../lib/kv";
import { Icon } from "./Icon";

type Nav = { onNavigate: (loc: Location) => void; onSelect: (sel: Selection) => void };

function useStoredJson<T>(key: string, initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setValue(raw ? (JSON.parse(raw) as T) : initial);
    } catch {
      setValue(initial);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // storage blocked — keep it in memory
    }
  };
  return [value, save];
}

const where = (index: ProjectIndex, w: CheckItem["at"]["where"]) =>
  w.kind === "aoi" ? `AOI ${w.owner}` : index.isLogix ? `${w.owner} › ${w.routine}` : `${index.program(w.owner)?.number ?? ""} - ${w.owner}`;

function SavedState({ ok }: { ok: boolean | null }) {
  if (ok === true) return <span className="chip on small" title="This condition was satisfied in the saved values">OK at save</span>;
  if (ok === false) return <span className="chip danger small" title="This condition was NOT satisfied in the saved values">Not OK at save</span>;
  return <span className="chip small" title="The export has no value for this">?</span>;
}

function needText(i: CheckItem): string {
  switch (i.category) {
    case "timer":
      return i.need === "done" ? "timer done" : "timing";
    case "setpoint":
      return i.need;
    case "aoi":
      return i.need;
    default:
      return `must be ${i.need}`;
  }
}

function CheckRow({
  item,
  index,
  ticked,
  onTick,
  nav,
  mode,
}: {
  item: CheckItem;
  index: ProjectIndex;
  ticked?: boolean;
  onTick?: () => void;
  nav: Nav;
  mode: "checklist" | "cause" | "reset";
}) {
  const verb = mode === "checklist" ? needText(item) : item.category === "timer" ? (item.need === "done" ? "has timed out" : "is timing") : item.category === "setpoint" ? "" : `is ${item.need}`;
  return (
    <li className={`check-row cat-${item.category}${ticked ? " ticked" : ""}`}>
      {onTick ? <input type="checkbox" className="check-box" checked={!!ticked} onChange={onTick} aria-label={`Checked ${item.label}`} /> : null}
      <div className="check-main">
        <div className="check-line">
          <span className="mono check-label">{item.label}</span>
          {verb ? <span className={`check-need need-${item.need === "OFF" ? "off" : item.need === "ON" ? "on" : "other"}`}>{verb}</span> : null}
          {item.description ? <span className="check-desc">{item.description}</span> : null}
        </div>
        <div className="check-meta small">
          {item.io ? (
            <span className="check-loc">
              <Icon name="pin" size={13} /> {item.io.location}
            </span>
          ) : null}
          {item.note ? <span className="muted">{item.note}</span> : null}
          {mode === "checklist" ? <SavedState ok={item.ok} /> : null}
          {mode === "checklist" && item.via ? <span className="muted">for {item.via}</span> : null}
          <span className="check-links no-print">
            {item.ref ? (
              <button type="button" className="link" onClick={() => nav.onNavigate({ view: "troubleshoot", ref: item.ref!, where: item.where })}>
                Why?
              </button>
            ) : null}
            <button
              type="button"
              className="link"
              onClick={() => {
                nav.onNavigate({ view: "routine", ref: item.at.where, rung: item.at.rung });
                if (item.ref) nav.onSelect({ kind: "ref", ref: item.ref, where: item.at.where, rung: item.at.rung });
              }}
            >
              {where(index, item.at.where)} · rung {item.at.rung}
            </button>
          </span>
        </div>
      </div>
    </li>
  );
}

/** Ungrouped items by category, then each "any one of these" group. */
function CheckSections({
  items,
  groups,
  index,
  nav,
  mode,
  ticks,
  onTick,
  headings = true,
}: {
  items: CheckItem[];
  groups: Record<string, string>;
  index: ProjectIndex;
  nav: Nav;
  mode: "checklist" | "cause" | "reset";
  ticks?: Set<string>;
  onTick?: (id: string) => void;
  headings?: boolean;
}) {
  const plain = items.filter((i) => !i.group);
  const grouped = Object.keys(groups)
    .map((g) => ({ id: g, title: groups[g]!, items: items.filter((i) => i.group === g) }))
    .filter((g) => g.items.length);
  const row = (i: CheckItem) => (
    <CheckRow key={i.id} item={i} index={index} nav={nav} mode={mode} {...(ticks ? { ticked: ticks.has(i.id) } : {})} {...(onTick ? { onTick: () => onTick(i.id) } : {})} />
  );
  return (
    <>
      {headings
        ? CATEGORY_ORDER.map((c) => {
            const list = plain.filter((i) => i.category === c);
            if (!list.length) return null;
            return (
              <section key={c} className="check-section">
                <h3 className="check-title">
                  {CATEGORY_TITLE[c]} <span className="muted small">{list.length}</span>
                </h3>
                <ul className="check-list">{list.map(row)}</ul>
              </section>
            );
          })
        : plain.length ? <ul className="check-list">{plain.map(row)}</ul> : null}
      {grouped.map((g) => (
        <section key={g.id} className="check-section check-group">
          <h3 className="check-title">{g.title}</h3>
          <ul className="check-list">{g.items.map(row)}</ul>
        </section>
      ))}
    </>
  );
}

/* ------------------------------ start-up checklist ----------------------------- */

const START_WORDS = /\b(run|running|start|motor|drive|pump|conveyor|enable|main|fan|blower|heater|cycle|auto)\b/i;

export function ChecklistView({
  index,
  items,
  io,
  machineKey,
  refName,
  where: scope,
  ...nav
}: {
  index: ProjectIndex;
  items: SearchItem[];
  io: IoGroup[];
  machineKey: string;
  refName?: string;
  where?: Scope;
} & Nav) {
  const [q, setQ] = useState("");
  const [recent, setRecent] = useStoredJson<{ ref: string; where: Scope; label: string }[]>(`clt-checklists:${machineKey}`, []);
  const anyScope: Scope = { kind: "program", owner: index.project.programs[0]?.name ?? "" };

  const result = useMemo(() => (refName ? buildChecklist(index, refName, scope ?? anyScope) : null), [index, refName, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const tickKey = `clt-ticks:${machineKey}:${result?.target.key ?? ""}`;
  const [tickList, setTickList] = useStoredJson<string[]>(tickKey, []);
  const ticks = new Set(tickList);
  const toggle = (id: string) => setTickList(ticks.has(id) ? tickList.filter((t) => t !== id) : [...tickList, id]);

  useEffect(() => {
    if (!result || !refName) return;
    const label = result.target.description?.replace(/\s*\n\s*/g, " ") ?? refName;
    const next = [{ ref: refName, where: scope ?? anyScope, label }, ...recent.filter((r) => r.ref !== refName)].slice(0, 8);
    if (JSON.stringify(next) !== JSON.stringify(recent)) setRecent(next);
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  const suggestions = useMemo(
    () =>
      io
        .flatMap((g) => g.points)
        .filter((p) => p.kind === "output" && p.usedInLogic && START_WORDS.test(`${p.description ?? ""} ${p.label}`))
        .slice(0, 18),
    [io],
  );
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    return items.filter((i) => i.kind === "tag" && i.select?.kind === "ref" && i.haystack.includes(t)).slice(0, 30);
  }, [items, q]);

  if (!result) {
    const pick = (ref: string, w: Scope) => nav.onNavigate({ view: "checklist", ref, where: w });
    return (
      <div className="view">
        <header className="view-head">
          <div className="eyebrow">Start-up checklist</div>
          <h1 className="view-title">What are you starting up?</h1>
          <p className="view-desc">
            Pick the output or bit that runs the machine (main drive, conveyor, &quot;machine running&quot;…). The tool follows the logic back and lists every field
            device, fault, timer and setpoint that has to be right, with where each one is wired. Tick them off as you go, or print it.
          </p>
          <div className="toolbar">
            <input className="input grow" autoFocus placeholder="Search a tag, address or description…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </header>
        {matches.length ? (
          <section className="card">
            <ul className="plain pick-list">
              {matches.map((m, i) => (
                <li key={i}>
                  <button type="button" className="link mono" onClick={() => pick(m.label, m.select!.kind === "ref" ? m.select!.where : anyScope)}>
                    {m.label}
                  </button>{" "}
                  <span className="muted small">{m.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {recent.length ? (
          <section className="card">
            <h2 className="card-title">Your checklists</h2>
            <ul className="plain pick-list">
              {recent.map((r) => (
                <li key={r.ref}>
                  <button type="button" className="link" onClick={() => pick(r.ref, r.where)}>
                    {r.label}
                  </button>{" "}
                  <span className="mono muted small">{r.ref}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {suggestions.length ? (
          <section className="card">
            <h2 className="card-title">Outputs that look like they start something</h2>
            <ul className="plain pick-list">
              {suggestions.map((p) => (
                <li key={p.label}>
                  <button type="button" className="link" onClick={() => pick(p.ref, p.where)}>
                    {p.description ?? p.label}
                  </button>{" "}
                  <span className="mono muted small">{p.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  }

  const okCount = result.items.filter((i) => i.ok === true).length;
  const field = result.items.filter((i) => i.category === "field-input").length;
  return (
    <div className="view checklist-view">
      <header className="view-head">
        <div className="eyebrow">Start-up checklist</div>
        <div className="view-title-row">
          <h1 className="view-title">{result.target.description?.replace(/\s*\n\s*/g, " ") ?? result.target.key}</h1>
          <span className="mono view-meta">{result.target.key}</span>
        </div>
        <p className="view-desc">
          {result.items.length} checks ({field} field devices) from {result.writers} rung{result.writers === 1 ? "" : "s"}. {okCount} were OK when the file was saved.
          &quot;Any one of these&quot; groups are alternatives; one of them is enough.
          {result.truncated ? " The list was cut at 250 checks; start from a more specific bit for the rest." : ""}
        </p>
        <div className="toolbar no-print">
          <span className="muted small">
            {ticks.size} of {result.items.length} ticked
          </span>
          <button type="button" className="btn ghost" onClick={() => setTickList([])} disabled={!ticks.size}>
            Clear ticks
          </button>
          <button type="button" className="btn ghost" onClick={() => nav.onNavigate({ view: "checklist" })}>
            Change target
          </button>
          <button type="button" className="btn" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </header>
      {result.items.length === 0 ? (
        <div className="empty-state">Nothing in the logic gates this — it has no conditions, or nothing writes it.</div>
      ) : (
        <CheckSections items={result.items} groups={result.groups} index={index} nav={nav} mode="checklist" ticks={ticks} onTick={toggle} />
      )}
    </div>
  );
}

/* --------------------------------- alarm handbook -------------------------------- */

export function HandbookView({ index, alarms, machineKey, machineName, ...nav }: { index: ProjectIndex; alarms: AlarmEntry[]; machineKey: string; machineName: string } & Nav) {
  const [filter, setFilter] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const [notes, setNote] = useKv<string>(`alarm:${machineKey}`);
  const [limit, setLimit] = useState(40);
  const q = filter.trim().toLowerCase();
  const shown = alarms.filter(
    (a) => (!onlyActive || a.active === true) && (!q || `${a.label} ${a.description ?? ""} ${a.comment ?? ""} ${notes[a.label] ?? ""}`.toLowerCase().includes(q)),
  );
  // Build entries for what's on screen (each one walks the logic).
  const entries = useMemo(() => alarmHandbook(index, shown.slice(0, limit)), [index, shown.map((a) => a.label).join("|"), limit]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="view handbook-view">
      <header className="view-head">
        <div className="eyebrow">Alarm handbook</div>
        <div className="view-title-row">
          <h1 className="view-title">{machineName}: alarms and what to check</h1>
          <span className="view-meta">{alarms.length} alarms</span>
        </div>
        <p className="view-desc">
          For each alarm bit: what raises it, how long it waits, how to reset it, and which field devices to check. Built from the logic. Add your own notes
          (&quot;last time it was the prox at the infeed&quot;); they&apos;re saved with this machine on this device.
        </p>
        <div className="toolbar no-print">
          <input className="input grow" placeholder="Find an alarm or note…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className={`toggle ${onlyActive ? "on" : ""}`} onClick={() => setOnlyActive((x) => !x)}>
            <span className="toggle-dot" aria-hidden />
            Active at save
          </button>
          <button type="button" className="btn" onClick={() => (shown.length > limit ? setLimit(shown.length) : window.print())}>
            {shown.length > limit ? `Load all ${shown.length} to print` : "Print"}
          </button>
        </div>
      </header>
      {entries.map((e) => {
        const a = e.alarm;
        const checks = e.causes.filter((c) => c.io);
        return (
          <article key={`${a.label}|${a.at.where.owner}`} className={`card hb-entry${a.active ? " alarm-active" : ""}`}>
            <h2 className="card-title hb-title">
              <span>
                {a.description ?? a.label}
                {a.description ? <span className="mono muted small"> {a.label}</span> : null}
              </span>
              <span className="hb-chips">
                {a.active ? <span className="chip danger small">ON at save</span> : null}
                {e.latched ? <span className="chip warn small">latched</span> : null}
                {e.delay ? <span className="chip small">after {e.delay}</span> : null}
              </span>
            </h2>
            {a.comment && a.comment !== a.description ? <p className="muted small hb-comment">{a.comment}</p> : null}
            <div className="hb-grid">
              <div>
                <h3 className="check-title">Raised when</h3>
                {e.causes.length ? (
                  <CheckSections items={e.causes} groups={e.causeGroups} index={index} nav={nav} mode="cause" headings={false} />
                ) : (
                  <p className="muted small">Set with no conditions (or only from outside the logic).</p>
                )}
              </div>
              <div>
                {checks.length ? (
                  <>
                    <h3 className="check-title">Check on the machine</h3>
                    <ul className="plain hb-checks small">
                      {checks.map((c) => (
                        <li key={c.id}>
                          <Icon name="pin" size={13} className="inline-ico" /> <strong>{c.io!.location}</strong> — {c.description ?? c.label} <span className="mono muted">{c.label}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <h3 className="check-title">{e.latched ? "To reset" : "Clears"}</h3>
                {e.latched ? (
                  e.resets.length ? (
                    <CheckSections items={e.resets} groups={{}} index={index} nav={nav} mode="reset" headings={false} />
                  ) : (
                    <p className="muted small">Nothing in the logic unlatches it.</p>
                  )
                ) : (
                  <p className="muted small">By itself, as soon as the conditions above are no longer true.</p>
                )}
                <label className="hb-note">
                  <span className="check-title">Notes</span>
                  <textarea
                    className="input"
                    rows={2}
                    defaultValue={notes[a.label] ?? ""}
                    placeholder="What fixed it last time…"
                    onBlur={(ev) => {
                      const v = ev.target.value.trim();
                      if (v !== (notes[a.label] ?? "")) setNote(a.label, v || null);
                    }}
                  />
                </label>
                <div className="small no-print">
                  <button type="button" className="link" onClick={() => nav.onNavigate({ view: "routine", ref: a.at.where, rung: a.at.rung })}>
                    {where(index, a.at.where)} · rung {a.at.rung}
                  </button>
                  {" · "}
                  <button type="button" className="link" onClick={() => nav.onNavigate({ view: "troubleshoot", ref: a.ref, where: { kind: a.where.kind, owner: a.where.owner } })}>
                    Why is it {a.active ? "ON" : "OFF"}?
                  </button>
                </div>
              </div>
            </div>
          </article>
        );
      })}
      {shown.length > limit ? (
        <button type="button" className="btn ghost load-more no-print" onClick={() => setLimit((l) => l + 40)}>
          Show more ({shown.length - limit} left)
        </button>
      ) : null}
      {!shown.length ? <div className="empty-state">No alarms match.</div> : null}
    </div>
  );
}

/* ---------------------------------- connections --------------------------------- */

const DIR: Record<CommLink["direction"], string> = { send: "sends →", receive: "← reads", both: "↔ both ways", unknown: "? not stated" };

export function ConnectionsView({ comms, index, onOpenNetwork, ...nav }: { comms: MachineComms; index: ProjectIndex; onOpenNetwork: () => void } & Nav) {
  const [showLocal, setShowLocal] = useState(false);
  const groups = groupByEndpoint(comms.links).filter((g) => showLocal || !g.local);
  const localCount = groupByEndpoint(comms.links).filter((g) => g.local).length;
  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">Connections</div>
        <div className="view-title-row">
          <h1 className="view-title">Who this machine talks to</h1>
          <span className="view-meta">{groups.length} partners</span>
        </div>
        <p className="view-desc">
          Messages, sockets and produced/consumed tags in the program, grouped by the device at the other end.
          {comms.ips.length ? (
            <>
              {" "}
              This controller&apos;s own Ethernet ports: <span className="mono">{comms.ips.join(", ")}</span>.
            </>
          ) : null}
        </p>
        <div className="toolbar">
          {localCount ? (
            <button type="button" className={`toggle ${showLocal ? "on" : ""}`} onClick={() => setShowLocal((x) => !x)}>
              <span className="toggle-dot" aria-hidden />
              Own I/O &amp; backplane ({localCount})
            </button>
          ) : null}
          <button type="button" className="btn" onClick={onOpenNetwork}>
            Plant network map →
          </button>
        </div>
      </header>
      {groups.length === 0 ? <div className="empty-state">No messages to other devices found in this export.</div> : null}
      {groups.map((g) => (
        <section key={g.endpoint} className="card">
          <h2 className="card-title">
            <span>
              {g.name} {g.address ? <span className="mono muted small">{g.address}</span> : null}
            </span>
            {g.local ? <span className="chip small">own I/O</span> : null}
          </h2>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {g.links.map((l, i) => (
                  <tr key={i}>
                    <td className="nowrap">
                      <span className={`dir dir-${l.direction}`}>{DIR[l.direction]}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link mono"
                        onClick={() => nav.onSelect({ kind: "ref", ref: l.tag.replace(/^[^:]+:(?=[A-Za-z_])/, ""), where: l.at?.where ?? { kind: "program", owner: index.project.programs[0]?.name ?? "", routine: "" } })}
                      >
                        {l.tag}
                      </button>
                      <div className="small">{l.detail}</div>
                      {l.description ? <div className="muted small">{l.description}</div> : null}
                    </td>
                    <td className="small nowrap">
                      {l.at ? (
                        <button type="button" className="link" onClick={() => nav.onNavigate({ view: "routine", ref: l.at!.where, rung: l.at!.rung })}>
                          {l.at.where.owner === l.at.where.routine ? l.at.where.owner : `${l.at.where.owner} › ${l.at.where.routine}`} · {l.at.rung}
                        </button>
                      ) : (
                        <span className="muted">unused</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
