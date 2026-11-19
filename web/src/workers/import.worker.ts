/// <reference lib="webworker" />
import { importFiles } from "@core/importers/index";
import type { InputFile, ProjectModel } from "@core/model/types";
import { analyzeProject, type AnalysisResult } from "../lib/analysis";

/** "model": parse and return the project. "analysis": parse and return only the library facts. */
export type ImportRequest = { id: number; files: InputFile[]; want?: "model" | "analysis" };
export type ImportResponse =
  | { id: number; ok: true; project?: ProjectModel; analysis?: AnalysisResult; ms: number }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<ImportRequest>) => {
  const { id, files, want = "model" } = event.data;
  const t0 = performance.now();
  try {
    const project = importFiles(files);
    const response: ImportResponse =
      want === "analysis"
        ? { id, ok: true, analysis: analyzeProject(project), ms: Math.round(performance.now() - t0) }
        : { id, ok: true, project, ms: Math.round(performance.now() - t0) };
    self.postMessage(response);
  } catch (err) {
    const response: ImportResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
