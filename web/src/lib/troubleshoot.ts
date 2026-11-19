import { formatValue, type ProjectIndex } from "@core/query/index";
import type { TraceResult, TraceWriter } from "@core/logic/trace";

const strip = (key: string) => key.replace(/^(Program|AOI):[^.]+\./, "");

export interface Verdict {
  tone: "ok" | "blocked" | "info";
  text: string;
  /** Writers worth showing first, with their blockers. */
  focus: TraceWriter[];
}

export function writerWhere(index: ProjectIndex, w: TraceWriter): string {
  const p = index.program(w.where.owner);
  const place = w.where.kind === "aoi" ? `AOI ${w.where.owner}` : index.isLogix ? `${w.where.owner} › ${w.where.routine}` : `${p?.number ?? ""} - ${w.where.owner}`;
  return `${w.instruction.mnemonic} in ${place}, rung ${w.hit.rung}`;
}

export function verdictFor(index: ProjectIndex, t: TraceResult): Verdict {
  const v = t.info.value;
  const direct = t.writers.filter((w) => w.direct);
  const on = direct.filter((w) => w.effect === "drive" || w.effect === "set");
  const off = direct.filter((w) => w.effect === "reset");
  const timer = direct.find((w) => w.effect === "timer");
  const member = t.info.key.match(/[./](DN|TT|EN)$/i)?.[1]?.toUpperCase();

  if (timer && member) {
    const base = index.resolve(strip(t.info.base), { kind: timer.where.kind, owner: timer.where.owner });
    const s = (typeof base.value === "object" && !Array.isArray(base.value) ? base.value : {}) as Record<string, unknown>;
    const acc = s.ACC as number | undefined;
    const pre = s.PRE as number | undefined;
    const progress = acc !== undefined && pre ? ` — ACC ${acc} of PRE ${pre} (${Math.min(100, Math.round((acc / pre) * 100))}%)` : "";
    if (timer.energized === false) {
      return { tone: "blocked", text: `The timer isn't running because its rung is false${progress}. What's blocking it:`, focus: [timer] };
    }
    if (s.DN === true) return { tone: "ok", text: `The timer is done${progress}.`, focus: [timer] };
    if (timer.energized === true) {
      return { tone: "info", text: `The timer's rung is true and it's timing${progress}. DN comes ON when ACC reaches PRE.`, focus: [timer] };
    }
  }

  if (typeof v === "boolean") {
    if (direct.length === 0) {
      if (t.io?.kind === "input") {
        return {
          tone: v ? "ok" : "blocked",
          text: v
            ? `Physical input (${t.io.location}) — the PLC sees it ON.`
            : `Physical input (${t.io.location}) — the PLC sees it OFF. Check the field device (sensor, switch, push button), its wiring/fuse and the input card's LED.`,
          focus: [],
        };
      }
      return {
        tone: "info",
        text: `Nothing in the ladder writes this — it's set from outside the logic (HMI/SCADA, a MSG or produced/consumed tag, an I/O module) or never changes.${t.writers.length ? " It is written as part of a larger structure below." : ""}`,
        focus: [],
      };
    }
    if (!v) {
      const resetting = off.find((w) => w.energized === true);
      if (resetting) return { tone: "blocked", text: `It's being turned OFF by ${writerWhere(index, resetting)}.`, focus: [resetting, ...on] };
      const fighting = on.find((w) => w.energized === true);
      if (fighting) {
        return {
          tone: "info",
          text: `${writerWhere(index, fighting)} has power, yet the saved value is OFF — something later in the scan turns it back OFF (an OTU, another OTE, or a copy into its structure). Check the other places that write it:`,
          focus: direct,
        };
      }
      if (on.length) {
        return { tone: "blocked", text: "It's OFF because none of the rungs that turn it ON have power. What's blocking each one:", focus: on };
      }
      return { tone: "info", text: "Only instructions that turn it OFF (or write it as a value) exist in the logic.", focus: direct };
    }
    const driving = on.find((w) => w.energized === true);
    if (driving) return { tone: "ok", text: `It's ON because ${writerWhere(index, driving)} has power.`, focus: [driving] };
    const latch = on.find((w) => w.effect === "set");
    if (latch) {
      return {
        tone: "info",
        text: off.length
          ? `It was latched ON earlier (${writerWhere(index, latch)}) and stays ON until an unlatch gets power. What's keeping each unlatch from running:`
          : `It was latched ON earlier (${writerWhere(index, latch)}) and nothing in the logic unlatches it.`,
        focus: off.length ? off : [latch],
      };
    }
    return { tone: "info", text: "It's ON in the saved values.", focus: direct };
  }

  if (typeof v === "number") return { tone: "info", text: `Its saved value is ${formatValue(v)}. Written by:`, focus: direct };
  return { tone: "info", text: "There's no saved value for this. Written by:", focus: direct };
}

