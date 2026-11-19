#!/usr/bin/env node
/**
 * Test harness: import an export (file or folder) the same way the web app does
 * and print a summary. Optionally write the model JSON with --out.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { ACCEPTED_EXTENSIONS, importFiles } from "../importers/index.js";
import type { InputFile } from "../model/types.js";

async function readInputs(path: string): Promise<InputFile[]> {
  const s = await stat(path);
  const paths = s.isFile() ? [path] : (await readdir(path)).map((e) => join(path, e));
  const files: InputFile[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (!ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
    // Exports are Windows-1252 text; latin1 keeps every byte.
    files.push({ name: basename(p), text: await readFile(p, "latin1") });
  }
  return files;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const input = args.find((a, i) => !a.startsWith("-") && (outIdx < 0 || i !== outIdx + 1));
  if (!input) {
    console.error("Usage: npm run import -- <export file or folder> [--out model.json]");
    process.exit(1);
  }
  const t0 = performance.now();
  const project = importFiles(await readInputs(resolve(input)));
  const ms = Math.round(performance.now() - t0);
  if (out) {
    await mkdir(dirname(resolve(out)), { recursive: true });
    await writeFile(resolve(out), JSON.stringify(project), "utf8");
  }
  console.log(JSON.stringify({ name: project.name, platform: project.platform, ms, stats: project.stats, warnings: project.warnings }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
