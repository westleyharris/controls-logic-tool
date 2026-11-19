import type { InputFile, ProjectModel } from "@core/model/types";
import type { ImportResponse } from "../workers/import.worker";
import type { AnalysisResult } from "./analysis";

type Done = Extract<ImportResponse, { ok: true }>;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: Done) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/import.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<ImportResponse>) => {
    const res = event.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res);
    else p.reject(new Error(res.error));
  };
  worker.onerror = (event) => {
    for (const p of pending.values()) p.reject(new Error(event.message || "Import worker crashed"));
    pending.clear();
    worker = null;
  };
  return worker;
}

function post(files: InputFile[], want: "model" | "analysis"): Promise<Done> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, files, want });
  });
}

/** Parse export files off the main thread. */
export async function importInWorker(files: InputFile[]): Promise<ProjectModel> {
  const res = await post(files, "model");
  if (!res.project) throw new Error("The import returned no project");
  return res.project;
}

/** Parse export files off the main thread and return only the library facts (comms, parts, search). */
export async function analyzeInWorker(files: InputFile[]): Promise<AnalysisResult> {
  const res = await post(files, "analysis");
  if (!res.analysis) throw new Error("The import returned no analysis");
  return res.analysis;
}

/**
 * Read a dropped file as text. Rockwell ASCII exports are Windows-1252;
 * L5X and some newer exports are UTF-8 (often with a BOM).
 */
export async function readExportFile(file: File): Promise<InputFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    text = new TextDecoder("utf-8").decode(bytes.subarray(3));
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder("windows-1252").decode(bytes);
    }
  }
  return { name: file.name, text };
}
