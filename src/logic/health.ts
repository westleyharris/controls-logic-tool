/**
 * Program-wide health checks: things a technician or engineer should know
 * about before trusting the logic or the saved values.
 */

import type { CrossReferenceEntry, CrossReferenceHit, RoutineRef } from "../model/types.js";
import { walkInstructions } from "../ladder/parse.js";
import type { ProjectIndex, Scope } from "../query/index.js";

export type Severity = "error" | "warning" | "info";

export interface HealthItem {
  label: string;
  detail?: string;
  /** Tag / address to inspect. */
  ref?: { ref: string; where: Scope & { routine: string } };
  /** Rung to open. */
  at?: { where: RoutineRef; rung: number };
}

export interface HealthFinding {
  id: string;
  severity: Severity;
  title: string;
  summary: string;
  items: HealthItem[];
  /** Total before the item list was capped. */
  total: number;
}

const MAX_ITEMS = 300;
const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

function finding(id: string, severity: Severity, title: string, summary: string, items: HealthItem[]): HealthFinding {
  return { id, severity, title, summary, items: items.slice(0, MAX_ITEMS), total: items.length };
}

function at(h: CrossReferenceHit): HealthItem["at"] {
  return { where: { kind: h.kind, owner: h.owner, routine: h.routine }, rung: h.rung };
}

function where(h: CrossReferenceHit): Scope & { routine: string } {
  return { kind: h.kind, owner: h.owner, routine: h.routine };
}

function loc(index: ProjectIndex, h: CrossReferenceHit): string {
  if (!index.isLogix) return `${index.program(h.owner)?.number ?? ""} - ${h.owner} rung ${h.rung}`;
  return `${h.owner} › ${h.routine} rung ${h.rung}`;
}

const display = (key: string) => key.replace(/^(Program|AOI):[^.]+\./, "");

/** PLC-5 status-file word as a list of set bits with their RSLogix descriptions. */
function statusBits(index: ProjectIndex, word: number): { bits: number[]; text: string[] } {
  const info = index.resolve(`S:${word}`, { kind: "program", owner: "" });
  const v = typeof info.value === "number" ? info.value & 0xffff : 0;
  const bits: number[] = [];
  const text: string[] = [];
  for (let b = 0; b < 16; b++) {
    if ((v >>> b) & 1) {
      bits.push(b);
      const d = index.resolve(`S:${word}/${b}`, { kind: "program", owner: "" }).description;
      text.push(`S:${word}/${b}${d ? ` — ${d}` : ""}`);
    }
  }
  return { bits, text };
}

/** PLC-5 processor clock (S:18–S:23) at the moment the file was saved. */
export function plc5SnapshotTime(index: ProjectIndex): string | undefined {
  if (index.isLogix) return undefined;
  const s = index.project.dataFiles.find((f) => f.name === "S");
  const w = (n: number) => (typeof s?.elements[n] === "number" ? (s.elements[n] as number) : NaN);
  // PLC-5 clock is S:18–S:23; SLC 5/03+ is S:37–S:42.
  const base = index.project.platform === "slc" ? 37 : 18;
  const [y, mo, d, h, mi, se] = [w(base), w(base + 1), w(base + 2), w(base + 3), w(base + 4), w(base + 5)];
  if (![y, mo, d, h, mi, se].every(Number.isFinite) || y < 1980 || mo < 1 || mo > 12) return undefined;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(se)}`;
}

export function runHealthChecks(index: ProjectIndex): HealthFinding[] {
  const project = index.project;
  const out: HealthFinding[] = [];
  const entries = project.crossReference;
  const programHits = (e: CrossReferenceEntry) => e.hits.filter((h) => h.kind === "program");
  const byKey = new Map(entries.map((e) => [e.key, e]));

  /* ----------------------------- forces & faults ----------------------------- */

  if (project.forces.length) {
    out.push(
      finding(
        "forces",
        "error",
        "Forces installed",
        "These I/O points are forced in the export. A forced point ignores the logic and the field device — remove forces before trusting what you see.",
        project.forces.map((f) => ({
          label: `${f.address} forced ${f.state.toUpperCase()}`,
          detail: index.resolve(f.address, { kind: "program", owner: "" }).description,
          ref: { ref: f.address, where: { kind: "program", owner: project.programs[0]?.name ?? "", routine: "" } },
        })),
      ),
    );
  }

  if (project.platform === "slc" && project.dataFiles.some((f) => f.name === "S")) {
    const sv = (n: number) => index.resolve(`S:${n}`, { kind: "program", owner: "" }).value;
    const major = sv(6);
    if (typeof major === "number" && major !== 0) {
      out.push(
        finding("major-fault", "error", "Major error code in the status file", "The SLC's major error code (S:6) was set when the file was saved — look it up in the SLC 500 status file reference.", [
          { label: `S:6 = ${major} (hex ${(major & 0xffff).toString(16).toUpperCase().padStart(4, "0")})` },
        ]),
      );
    }
    const minor = sv(5);
    if (typeof minor === "number" && minor & 0xffff) {
      const bits = Array.from({ length: 16 }, (_, b) => b).filter((b) => (minor >>> b) & 1);
      out.push(
        finding("minor-fault", "warning", "Minor error bits set (S:5)", "Minor error bits don't stop the processor (math overflow, etc.). Check the SLC 500 status file reference for each bit.", bits.map((b) => ({ label: `S:5/${b}` }))),
      );
    }
  }

  if (project.platform === "plc5" && project.dataFiles.some((f) => f.name === "S")) {
    const major = statusBits(index, 11);
    const code = index.resolve("S:12", { kind: "program", owner: "" }).value;
    if (major.bits.length || (typeof code === "number" && code !== 0)) {
      const file = index.resolve("S:13", { kind: "program", owner: "" }).value;
      const rung = index.resolve("S:14", { kind: "program", owner: "" }).value;
      out.push(
        finding("major-fault", "error", "Major fault recorded in the status file", "The processor's major-fault word / fault code was set when the file was saved.", [
          ...major.text.map((t) => ({ label: t })),
          ...(typeof code === "number" && code !== 0 ? [{ label: `Fault code S:12 = ${code}`, detail: `Program file ${file ?? "?"}, rung ${rung ?? "?"}` }] : []),
        ]),
      );
    }
    const minor = [...statusBits(index, 10).text, ...statusBits(index, 17).text];
    if (minor.length) {
      out.push(
        finding(
          "minor-fault",
          "warning",
          "Minor fault bits set",
          "Minor faults don't stop the processor, but they point at real problems (communications, overflow, battery…).",
          minor.map((t) => ({ label: t })),
        ),
      );
    }
  }

  /* ------------------------------- output usage ------------------------------ */

  const dupItems: HealthItem[] = [];
  const mixedItems: HealthItem[] = [];
  const latchItems: HealthItem[] = [];
  const unlatchOnly: HealthItem[] = [];
  for (const e of entries) {
    const hits = programHits(e);
    if (!hits.length) continue;
    const ote = hits.filter((h) => h.mnemonic.toUpperCase() === "OTE");
    const otl = hits.filter((h) => h.mnemonic.toUpperCase() === "OTL");
    const otu = hits.filter((h) => h.mnemonic.toUpperCase() === "OTU");
    const rungsOf = (hs: CrossReferenceHit[]) => new Set(hs.map((h) => `${h.owner}|${h.routine}|${h.rung}`));
    if (rungsOf(ote).size > 1) {
      dupItems.push({
        label: display(e.key),
        detail: `OTE in ${ote.map((h) => loc(index, h)).join("; ")}`,
        ref: { ref: ote[0]!.address, where: where(ote[0]!) },
        at: at(ote[0]!),
      });
    }
    if (ote.length && (otl.length || otu.length)) {
      mixedItems.push({
        label: display(e.key),
        detail: `OTE in ${loc(index, ote[0]!)}; ${otl.length ? `OTL in ${loc(index, otl[0]!)}` : `OTU in ${loc(index, otu[0]!)}`}`,
        ref: { ref: ote[0]!.address, where: where(ote[0]!) },
        at: at(ote[0]!),
      });
    }
    // Latched but never unlatched — unless something writes a parent structure (COP/MOV/CLR…).
    const parentWritten = (() => {
      let k = e.key;
      for (;;) {
        const next = k.replace(/(\.[^.[\]/]+|\[[^\]]*\]|\/\w+)$/, "");
        if (next === k || next.length < e.base.length) return false;
        k = next;
        if (byKey.get(k)?.hits.some((h) => h.access === "write")) return true;
      }
    })();
    const otherWrites = hits.some((h) => h.access === "write" && !["OTL", "OTU", "OTE"].includes(h.mnemonic.toUpperCase()));
    if (otl.length && !otu.length && !ote.length && !parentWritten && !otherWrites) {
      latchItems.push({
        label: display(e.key),
        detail: `Latched in ${loc(index, otl[0]!)} — nothing in the logic unlatches it`,
        ref: { ref: otl[0]!.address, where: where(otl[0]!) },
        at: at(otl[0]!),
      });
    }
    if (otu.length && !otl.length && !ote.length && !parentWritten && !otherWrites) {
      unlatchOnly.push({
        label: display(e.key),
        detail: `Unlatched in ${loc(index, otu[0]!)} but never latched by the logic`,
        ref: { ref: otu[0]!.address, where: where(otu[0]!) },
        at: at(otu[0]!),
      });
    }
  }
  if (dupItems.length) {
    out.push(
      finding(
        "duplicate-ote",
        "warning",
        "Same output driven by more than one OTE",
        "When two rungs OTE the same bit, the last one scanned wins and the earlier rung has no effect. Sometimes intentional (JMP/subroutines), often a bug.",
        dupItems,
      ),
    );
  }
  if (mixedItems.length) {
    out.push(
      finding(
        "mixed-ote-latch",
        "warning",
        "Bit written by both OTE and OTL/OTU",
        "Mixing OTE with latch/unlatch on the same bit makes its state depend on scan order.",
        mixedItems,
      ),
    );
  }
  if (latchItems.length) {
    out.push(
      finding(
        "latch-no-unlatch",
        "warning",
        "Latched (OTL) but never unlatched",
        "Once these turn ON, nothing in the ladder turns them OFF. They may be reset from the HMI, by a power cycle, or not at all.",
        latchItems,
      ),
    );
  }
  if (unlatchOnly.length) {
    out.push(finding("unlatch-no-latch", "info", "Unlatched (OTU) but never latched", "Probably set from the HMI or another device.", unlatchOnly));
  }

  /* ------------------------------ timers running ----------------------------- */

  const timers: HealthItem[] = [];
  if (!index.isLogix) {
    for (const f of project.dataFiles.filter((x) => x.type === "T")) {
      f.elements.forEach((el, i) => {
        if (!Array.isArray(el) || el.length < 3) return;
        const ctl = el[0] ?? 0;
        if ((ctl >>> 14) & 1) {
          const addr = `${f.name}:${i}`;
          const hit = byKey.get(addr)?.hits[0];
          timers.push({
            label: addr,
            detail: `${index.resolve(addr, { kind: "program", owner: "" }).description ?? ""} — ${el[2]} of ${el[1]}`.replace(/^ — /, ""),
            ref: { ref: addr, where: hit ? where(hit) : { kind: "program", owner: project.programs[0]?.name ?? "", routine: "" } },
            ...(hit ? { at: at(hit) } : {}),
          });
        }
      });
    }
  } else {
    for (const t of project.tags) {
      if (t.dataType.toUpperCase() !== "TIMER" || t.dims || typeof t.value !== "object" || Array.isArray(t.value)) continue;
      const v = t.value as Record<string, unknown>;
      if (v.TT === true) {
        const key = t.scope ? `Program:${t.scope}.${t.name}` : t.name;
        const hit = byKey.get(key)?.hits[0];
        timers.push({
          label: t.scope ? `${t.scope}.${t.name}` : t.name,
          detail: `${t.description?.replace(/\s*\n\s*/g, " ") ?? ""} — ${String(v.ACC)} of ${String(v.PRE)} ms`.replace(/^ — /, ""),
          ref: { ref: t.name, where: { kind: "program", owner: t.scope, routine: hit?.routine ?? "" } },
          ...(hit ? { at: at(hit) } : {}),
        });
      }
    }
  }
  if (timers.length) {
    out.push(
      finding(
        "timers-timing",
        "info",
        "Timers that were running when the file was saved",
        "These timers had their TT (timing) bit ON in the saved values. Useful when a machine was saved mid-sequence or stuck waiting on a delay.",
        timers,
      ),
    );
  }

  /* --------------------------- structure: JSRs etc. --------------------------- */

  const called = new Set<string>();
  const missing: HealthItem[] = [];
  const afi: HealthItem[] = [];
  for (const p of project.programs) {
    for (const r of p.routines) {
      for (const rung of r.rungs) {
        if (!rung.ladder) continue;
        const here: RoutineRef = { kind: "program", owner: p.name, routine: r.name };
        walkInstructions(rung.ladder, (ins) => {
          const m = ins.mnemonic.toUpperCase();
          if (m === "JSR") {
            const target = index.jsrTarget(ins.operands, here);
            if (target) called.add(`${target.owner}|${target.routine}`);
            else missing.push({ label: `JSR ${ins.operands[0] ?? "?"}`, detail: `${p.name} › ${r.name} rung ${rung.index}`, at: { where: here, rung: rung.index } });
          }
          if (m === "AFI") afi.push({ label: `${p.name} › ${r.name} rung ${rung.index}`, detail: rung.comment?.split("\n")[0], at: { where: here, rung: rung.index } });
        });
      }
    }
  }
  if (missing.length) out.push(finding("jsr-missing", "warning", "JSR to a routine that doesn't exist", "The called routine / program file isn't in the export.", missing));
  if (afi.length) out.push(finding("afi", "info", "Rungs disabled with AFI", "An AFI (Always False) instruction keeps these rungs from ever running.", afi));

  // Routines nothing calls.
  const unused: HealthItem[] = [];
  const s = (n: number) => index.resolve(`S:${n}`, { kind: "program", owner: "" }).value;
  const plc5Special = new Set([2, s(29), s(31), s(46)].filter((n): n is number => typeof n === "number" && n > 0));
  for (const p of project.programs) {
    for (const r of p.routines) {
      if (index.isLogix) {
        if (r.name === p.mainRoutine || r.name === p.faultRoutine) continue;
      } else if (p.number !== undefined && plc5Special.has(p.number)) continue;
      if (!called.has(`${p.name}|${r.name}`)) {
        unused.push({
          label: index.isLogix ? `${p.name} › ${r.name}` : `${p.number} - ${p.name}`,
          detail: `${r.rungs.length} rungs, never called by a JSR`,
          at: { where: { kind: "program", owner: p.name, routine: r.name }, rung: 0 },
        });
      }
    }
  }
  if (unused.length) {
    out.push(
      finding(
        "unused-routines",
        "info",
        "Routines / program files nothing calls",
        index.isLogix
          ? "Not the program's main or fault routine, and no JSR calls them — they never run."
          : "No JSR calls these program files (and they aren't the main, fault, STI or PII file) — they may never run.",
        unused,
      ),
    );
  }

  if (index.isLogix) {
    const callCounts = new Map<string, number>();
    for (const p of project.programs) {
      for (const r of p.routines) {
        for (const rung of r.rungs) {
          if (rung.ladder) walkInstructions(rung.ladder, (ins) => callCounts.set(ins.mnemonic.toUpperCase(), (callCounts.get(ins.mnemonic.toUpperCase()) ?? 0) + 1));
        }
      }
    }
    for (const a of project.aois) {
      for (const r of a.routines) {
        for (const rung of r.rungs) {
          if (rung.ladder) walkInstructions(rung.ladder, (ins) => callCounts.set(ins.mnemonic.toUpperCase(), (callCounts.get(ins.mnemonic.toUpperCase()) ?? 0) + 1));
        }
      }
    }
    const unusedAoi = project.aois.filter((a) => !callCounts.get(a.name.toUpperCase()));
    if (unusedAoi.length) {
      out.push(
        finding(
          "unused-aoi",
          "info",
          "Add-On Instructions that are never called",
          "Defined in the project but not used anywhere in the logic.",
          unusedAoi.map((a) => ({ label: a.name, detail: a.description?.split("\n")[0] })),
        ),
      );
    }

    const disabled: HealthItem[] = [];
    for (const p of project.programs) if (p.disabled) disabled.push({ label: `Program ${p.name}`, detail: "Disabled — its logic doesn't run" });
    for (const t of project.tasks) if (t.inhibited) disabled.push({ label: `Task ${t.name}`, detail: "Inhibited — its programs don't run" });
    const walkMods = (list: typeof project.modules) => {
      for (const m of list) {
        if (m.inhibited) disabled.push({ label: `Module ${m.name}`, detail: `${m.catalogNumber ?? ""} inhibited — no I/O updates`.trim() });
        walkMods(m.children);
      }
    };
    walkMods(project.modules);
    if (disabled.length) out.push(finding("disabled", "warning", "Disabled programs, inhibited tasks or modules", "These parts of the project are switched off.", disabled));

    const scheduled = new Set(project.tasks.flatMap((t) => t.programs));
    const unsched = project.programs.filter((p) => !scheduled.has(p.name) && !/fault/i.test(p.name));
    if (unsched.length) {
      out.push(
        finding("unscheduled", "info", "Programs not scheduled in any task", "These programs don't run unless they're the controller fault handler or power-up handler.", unsched.map((p) => ({ label: p.name, detail: p.description?.split("\n")[0] }))),
      );
    }
  }

  /* ---------------------------- read / write orphans --------------------------- */

  const isPhysicalOrSystem = (key: string): boolean => {
    if (!index.isLogix) return /^(I|O|S):/.test(key);
    if (/^AOI:/.test(key) || /^S:/.test(key) || /:[ICO]\b/.test(key)) return true;
    const info = index.resolve(display(key), { kind: "program", owner: key.match(/^Program:([^.]+)\./)?.[1] ?? "" });
    return !!info.aliasFor;
  };

  const neverWritten = new Map<string, { count: number; hit: CrossReferenceHit }>();
  const neverRead: HealthItem[] = [];
  for (const e of entries) {
    const hits = programHits(e);
    if (!hits.length || isPhysicalOrSystem(e.key)) continue;
    const writes = hits.some((h) => h.access === "write");
    const reads = hits.some((h) => h.access === "read");
    if (!writes) {
      // Skip if a parent structure is written (e.g. COP into the UDT).
      let k = e.key;
      let parent = false;
      for (;;) {
        const next = k.replace(/(\.[^.[\]/]+|\[[^\]]*\]|\/\w+)$/, "");
        if (next === k || next.length < e.base.length) break;
        k = next;
        if (byKey.get(k)?.hits.some((h) => h.access === "write")) parent = true;
      }
      if (!parent) {
        const cur = neverWritten.get(e.base);
        if (cur) cur.count += 1;
        else neverWritten.set(e.base, { count: 1, hit: hits[0]! });
      }
    }
    if (writes && !reads && !hits.some((h) => h.mnemonic.toUpperCase() === "MSG")) {
      // A bit written but never examined. Ignore when anything reads its parent structure (e.g. COP of the whole UDT).
      const base = byKey.get(e.base);
      const baseRead = base && base !== e && base.hits.some((h) => h.access === "read");
      if (!baseRead) {
        neverRead.push({ label: display(e.key), detail: `Written in ${loc(index, hits.find((h) => h.access === "write")!)}`, ref: { ref: hits[0]!.address, where: where(hits[0]!) }, at: at(hits[0]!) });
      }
    }
  }
  if (neverWritten.size) {
    out.push(
      finding(
        "read-never-written",
        "info",
        "Read by the logic but never written by it",
        "These values must come from somewhere else — the HMI, a MSG/produced-consumed tag, an I/O module — or they never change. Worth checking when a permissive never comes true.",
        [...neverWritten.entries()].map(([base, v]) => ({
          label: display(base),
          detail: v.count > 1 ? `${v.count} members read` : index.resolve(v.hit.address, where(v.hit)).description,
          ref: { ref: v.hit.address, where: where(v.hit) },
          at: at(v.hit),
        })),
      ),
    );
  }
  if (neverRead.length) {
    out.push(
      finding(
        "written-never-read",
        "info",
        "Written by the logic but never read by it",
        "Often HMI/SCADA status bits (fine), sometimes leftovers from old code.",
        neverRead,
      ),
    );
  }

  /* --------------------------------- protected -------------------------------- */

  const encoded = [
    ...project.aois.filter((a) => a.encoded).map((a) => ({ label: `AOI ${a.name}`, detail: a.description?.split("\n")[0] })),
    ...project.programs.flatMap((p) => p.routines.filter((r) => r.encoded).map((r) => ({ label: `${p.name} › ${r.name}`, detail: r.description?.split("\n")[0] }))),
  ];
  if (encoded.length) {
    out.push(finding("protected", "info", "Source-protected logic", "These can't be viewed in the export, so tracing stops at their boundary.", encoded));
  }

  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
