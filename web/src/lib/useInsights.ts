import { useEffect, useState } from "react";
import { analyzeInWorker } from "./importer";
import { ensureMachineFiles } from "./sync";
import {
  getMachine,
  INSIGHTS_VERSION,
  insightsFresh,
  listInsights,
  putInsights,
  type MachineInsights,
  type MachineSummary,
} from "./machines";

export interface IndexProgress {
  done: number;
  total: number;
  current: string;
}

/**
 * Library-wide facts for every machine. Loads what's stored and, while
 * `enabled`, re-reads any machine whose export changed since it was indexed.
 */
export function useLibraryInsights(machines: MachineSummary[], enabled: boolean) {
  const [insights, setInsights] = useState<Map<string, MachineInsights>>(() => new Map());
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const map = new Map((await listInsights()).map((i) => [i.machineId, i]));
      if (cancelled) return;
      setInsights(new Map(map));
      const stale = machines.filter((m) => !insightsFresh(map.get(m.id), m));
      const errors: string[] = [];
      for (let k = 0; k < stale.length; k++) {
        if (cancelled) return;
        const m = stale[k]!;
        setProgress({ done: k, total: stale.length, current: m.name });
        try {
          const stored = await getMachine(m.id);
          if (!stored) continue;
          // Cloud machines not on this device yet get downloaded first.
          const full = await ensureMachineFiles(stored);
          const analysis = await analyzeInWorker(full.files);
          const rec: MachineInsights = { ...analysis, machineId: full.id, version: INSIGHTS_VERSION, stamp: full.updatedAt };
          await putInsights(rec);
          map.set(full.id, rec);
          if (!cancelled) setInsights(new Map(map));
        } catch {
          errors.push(m.name);
        }
      }
      if (!cancelled) {
        setProgress(null);
        setFailed(errors);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, machines]);

  return { insights, progress, failed };
}
