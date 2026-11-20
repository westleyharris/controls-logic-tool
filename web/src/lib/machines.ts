import type { InputFile, PlatformFamily } from "@core/model/types";
import type { AnalysisResult } from "./analysis";

/**
 * The machine library: every machine you've added, with its export files.
 * Stored in this browser's IndexedDB (local only, nothing uploaded).
 */
export interface Machine {
  id: string;
  /** Your name for the machine, e.g. "Filler / Seamer". */
  name: string;
  /** Organization: Company → Line → Machine. Empty = unassigned. */
  company?: string;
  line?: string;
  /** Free-form notes (area, OEM, anything). */
  location?: string;
  /** Controller / project name from the export. */
  projectName: string;
  platform: PlatformFamily;
  processor?: string;
  fileNames: string[];
  size: number;
  addedAt: number;
  /** When the export files last changed (also stamps the library index). */
  updatedAt: number;
  openedAt?: number;
  files: InputFile[];

  /* ---- cloud sync (only when signed in) ---- */
  /** When name / company / line / notes last changed. */
  editedAt?: number;
  /** Bumped every time new export files are uploaded. */
  exportVersion?: number;
  /** Last successful sync with the cloud. */
  syncedAt?: number;
  /** The cloud row's updated_at we last saw. */
  cloudUpdatedAt?: number;
  /** Details changed here and not pushed yet. */
  dirty?: boolean;
  /** Export files changed here and not uploaded yet. */
  filesDirty?: boolean;
  /** In the cloud library; files not downloaded to this device yet. */
  remote?: boolean;
}

export type MachineSummary = Omit<Machine, "files">;

const DB_NAME = "controls-logic-tool";
const DB_VERSION = 4;
const STORE = "machines";
const ATTACH_STORE = "attachments";
const INSIGHTS_STORE = "insights";
const LEGACY_STORE = "recent-projects";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(ATTACH_STORE)) {
        db.createObjectStore(ATTACH_STORE, { keyPath: "id" }).createIndex("machineId", "machineId");
      }
      if (!db.objectStoreNames.contains(INSIGHTS_STORE)) db.createObjectStore(INSIGHTS_STORE, { keyPath: "machineId" });
      // v1 kept a short "recent projects" list — carry those over as machines.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(LEGACY_STORE)) {
        const tx = req.transaction!;
        const legacy = tx.objectStore(LEGACY_STORE).getAll();
        legacy.onsuccess = () => {
          const machines = tx.objectStore(STORE);
          for (const old of legacy.result as Record<string, unknown>[]) {
            const now = Date.now();
            machines.put({
              id: crypto.randomUUID(),
              name: String(old.name ?? "Machine"),
              projectName: String(old.name ?? ""),
              platform: old.platform ?? "unknown",
              processor: old.processor,
              fileNames: old.fileNames ?? [],
              size: old.size ?? 0,
              addedAt: (old.openedAt as number) ?? now,
              updatedAt: (old.openedAt as number) ?? now,
              openedAt: old.openedAt,
              files: old.files ?? [],
            });
          }
          db.deleteObjectStore(LEGACY_STORE);
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>, storeName = STORE): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const req = fn(tx.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** Ask the browser not to evict the library when disk space runs low. */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.();
  } catch {
    // Not supported — the library still works, it's just evictable.
  }
}

export async function listMachines(): Promise<MachineSummary[]> {
  const all = await run<Machine[]>("readonly", (s) => s.getAll() as IDBRequest<Machine[]>);
  return all
    .map(({ files: _files, ...rest }) => rest)
    .sort((a, b) => (b.openedAt ?? b.updatedAt) - (a.openedAt ?? a.updatedAt));
}

export function getMachine(id: string): Promise<Machine | undefined> {
  return run<Machine | undefined>("readonly", (s) => s.get(id) as IDBRequest<Machine | undefined>);
}

export async function putMachine(machine: Machine): Promise<void> {
  await run("readwrite", (s) => s.put(machine));
}

export async function updateMachine(id: string, patch: Partial<Machine>): Promise<Machine | undefined> {
  const m = await getMachine(id);
  if (!m) return undefined;
  const next = { ...m, ...patch };
  await putMachine(next);
  return next;
}

/** Remember deletions made while offline so the cloud copy goes too. */
const DELETED_KEY = "clt-deleted";
export function pendingDeletes(): { machines: string[]; attachments: string[] } {
  try {
    return { machines: [], attachments: [], ...(JSON.parse(localStorage.getItem(DELETED_KEY) ?? "{}") as object) };
  } catch {
    return { machines: [], attachments: [] };
  }
}
export function setPendingDeletes(d: { machines: string[]; attachments: string[] }): void {
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify(d));
  } catch {
    // ignore
  }
}

/** Delete a machine you removed (also from the cloud on the next sync). */
export async function deleteMachine(id: string): Promise<void> {
  const m = await getMachine(id);
  if (m?.syncedAt) {
    const d = pendingDeletes();
    setPendingDeletes({ ...d, machines: [...new Set([...d.machines, id])] });
  }
  await deleteMachineLocal(id);
}

/** Remove a machine from this device only (e.g. it was deleted on another device). */
export async function deleteMachineLocal(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
  await run("readwrite", (s) => s.delete(id), INSIGHTS_STORE);
  for (const a of await listAttachments(id)) await run("readwrite", (s) => s.delete(a.id), ATTACH_STORE);
}

/* --------------------------------- insights ---------------------------------- */

/**
 * What the library needs from each machine without re-parsing its export:
 * who it talks to, its hardware, and a search index. Rebuilt when the export
 * changes or INSIGHTS_VERSION goes up.
 */
export const INSIGHTS_VERSION = 2;

export interface MachineInsights extends AnalysisResult {
  machineId: string;
  version: number;
  /** The machine's updatedAt when this was built. */
  stamp: number;
}

export function listInsights(): Promise<MachineInsights[]> {
  return run<MachineInsights[]>("readonly", (s) => s.getAll() as IDBRequest<MachineInsights[]>, INSIGHTS_STORE);
}

export function getInsights(id: string): Promise<MachineInsights | undefined> {
  return run<MachineInsights | undefined>("readonly", (s) => s.get(id) as IDBRequest<MachineInsights | undefined>, INSIGHTS_STORE);
}

export async function putInsights(i: MachineInsights): Promise<void> {
  await run("readwrite", (s) => s.put(i), INSIGHTS_STORE);
}

export function insightsFresh(i: MachineInsights | undefined, m: MachineSummary): boolean {
  return !!i && i.version === INSIGHTS_VERSION && i.stamp === m.updatedAt;
}

/* -------------------------------- attachments -------------------------------- */

/** An electrical drawing, photo or document stored with a machine. */
export interface Attachment {
  id: string;
  machineId: string;
  kind: "drawing" | "photo" | "document";
  name: string;
  mime: string;
  size: number;
  /** PDFs: number of pages and the text found on each (for search and the AI). */
  pageCount?: number;
  pagesText?: string[];
  addedAt: number;
  blob: Blob;
  /** Uploaded to / downloaded from the cloud. */
  syncedAt?: number;
}

export type AttachmentSummary = Omit<Attachment, "blob">;

export async function listAttachments(machineId: string): Promise<Attachment[]> {
  const all = await run<Attachment[]>(
    "readonly",
    (s) => s.index("machineId").getAll(machineId) as IDBRequest<Attachment[]>,
    ATTACH_STORE,
  );
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export async function putAttachment(a: Attachment): Promise<void> {
  await run("readwrite", (s) => s.put(a), ATTACH_STORE);
}

export async function deleteAttachment(id: string): Promise<void> {
  const all = await run<Attachment | undefined>("readonly", (s) => s.get(id) as IDBRequest<Attachment | undefined>, ATTACH_STORE);
  if (all?.syncedAt) {
    const d = pendingDeletes();
    setPendingDeletes({ ...d, attachments: [...new Set([...d.attachments, id])] });
  }
  await run("readwrite", (s) => s.delete(id), ATTACH_STORE);
}

export async function deleteAttachmentLocal(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id), ATTACH_STORE);
}

/** Every machine with its files (for sync). */
export function listMachinesFull(): Promise<Machine[]> {
  return run<Machine[]>("readonly", (s) => s.getAll() as IDBRequest<Machine[]>);
}

const LAST_KEY = "clt-last-machine";

export function rememberLastMachine(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch {
    // ignore
  }
}

export function lastMachineId(): string | null {
  try {
    return localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
}

/* ------------------------------ organization ------------------------------ */

export const NO_COMPANY = "No company";
export const NO_LINE = "No line";

/** What you type when adding or editing a machine. */
export interface MachineDetails {
  name: string;
  company: string;
  line: string;
  notes: string;
}

export function detailsPatch(d: MachineDetails): Partial<Machine> {
  return {
    name: d.name,
    company: d.company || undefined,
    line: d.line || undefined,
    location: d.notes || undefined,
    dirty: true,
    editedAt: Date.now(),
  };
}

export interface LineGroup {
  line: string;
  /** Raw value ("" when unassigned). */
  key: string;
  machines: MachineSummary[];
}

export interface CompanyGroup {
  company: string;
  key: string;
  lines: LineGroup[];
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Company → Line → Machine, alphabetical, with unassigned groups last. */
export function groupMachines(machines: MachineSummary[]): CompanyGroup[] {
  const companies = new Map<string, Map<string, MachineSummary[]>>();
  for (const m of machines) {
    const c = m.company?.trim() ?? "";
    const l = m.line?.trim() ?? "";
    if (!companies.has(c)) companies.set(c, new Map());
    const lines = companies.get(c)!;
    if (!lines.has(l)) lines.set(l, []);
    lines.get(l)!.push(m);
  }
  const sortKeys = (keys: string[]) => keys.sort((a, b) => (a === "" ? 1 : b === "" ? -1 : byName(a, b)));
  return sortKeys([...companies.keys()]).map((c) => {
    const lines = companies.get(c)!;
    return {
      company: c || NO_COMPANY,
      key: c,
      lines: sortKeys([...lines.keys()]).map((l) => ({
        line: l || NO_LINE,
        key: l,
        machines: lines.get(l)!.sort((a, b) => byName(a.name, b.name)),
      })),
    };
  });
}

export function companiesOf(machines: MachineSummary[]): string[] {
  return [...new Set(machines.map((m) => m.company?.trim()).filter((c): c is string => !!c))].sort(byName);
}

export function linesOf(machines: MachineSummary[], company: string): string[] {
  return [
    ...new Set(
      machines
        .filter((m) => (m.company?.trim() ?? "") === company.trim())
        .map((m) => m.line?.trim())
        .filter((l): l is string => !!l),
    ),
  ].sort(byName);
}

/** Rename a company (or assign one to every unassigned machine when `from` is ""). */
export async function renameCompany(from: string, to: string): Promise<void> {
  const all = await run<Machine[]>("readonly", (s) => s.getAll() as IDBRequest<Machine[]>);
  for (const m of all) {
    if ((m.company?.trim() ?? "") === from) await putMachine({ ...m, company: to.trim() || undefined, dirty: true, editedAt: Date.now() });
  }
}

/** Rename a line within a company (or assign one to its machines without a line when `from` is ""). */
export async function renameLine(company: string, from: string, to: string): Promise<void> {
  const all = await run<Machine[]>("readonly", (s) => s.getAll() as IDBRequest<Machine[]>);
  for (const m of all) {
    if ((m.company?.trim() ?? "") === company && (m.line?.trim() ?? "") === from) {
      await putMachine({ ...m, line: to.trim() || undefined, dirty: true, editedAt: Date.now() });
    }
  }
}

export function platformLabel(p: string): string {
  return p === "logix" ? "Logix" : p === "plc5" ? "PLC-5" : p === "slc" ? "SLC 500" : p === "unknown" ? "Panel only" : p;
}
