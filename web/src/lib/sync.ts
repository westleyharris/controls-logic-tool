import type { InputFile } from "@core/model/types";
import { getCloudState, setCloudState, supabase } from "./cloud";
import { kvDrop, kvEntries, kvMerge, kvScopes, setKvListener, type KvEntry } from "./kv";
import {
  deleteAttachmentLocal,
  deleteMachineLocal,
  getMachine,
  listAttachments,
  listMachinesFull,
  pendingDeletes,
  putAttachment,
  putMachine,
  setPendingDeletes,
  type Attachment,
  type Machine,
} from "./machines";

/**
 * Two-way sync between this device's library (IndexedDB) and the cloud.
 * Details: newest edit wins. Export files: uploaded gzipped, downloaded on
 * first open. Drawings: synced per machine when it's opened. Notes: newest
 * entry wins. Deletes made offline are remembered and sent later.
 */

const BUCKET = "machine-files";
const OWNER_KEY = "clt-cloud-owner";

interface MachineRow {
  id: string;
  name: string;
  company: string | null;
  line: string | null;
  notes: string | null;
  project_name: string;
  platform: string;
  processor: string | null;
  file_names: string[];
  size: number;
  export_version: number;
  added_at: string;
  updated_at: string;
}

interface AttachmentRow {
  id: string;
  machine_id: string;
  kind: Attachment["kind"];
  name: string;
  mime: string;
  size: number;
  page_count: number | null;
  pages_text: string[] | null;
  storage_path: string;
  created_at: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
const exportPath = (uid: string, machineId: string, i: number, name: string) => `${uid}/${machineId}/export/${i}-${safeName(name)}.gz`;
const attachmentPath = (uid: string, a: Attachment) => `${uid}/${a.machineId}/attachments/${a.id}-${safeName(a.name)}`;

function uid(): string {
  const u = getCloudState().user;
  if (!u) throw new Error("Not signed in");
  return u.id;
}

/* ----------------------------------- gzip ----------------------------------- */

async function gzipText(text: string): Promise<Blob> {
  const raw = new Blob([text], { type: "text/plain" });
  if (typeof CompressionStream === "undefined") return raw;
  return new Response(raw.stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

async function gunzipText(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gz = head[0] === 0x1f && head[1] === 0x8b;
  if (!gz || typeof DecompressionStream === "undefined") return blob.text();
  return new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/* --------------------------------- machines --------------------------------- */

function toRow(m: Machine, exportVersion: number): MachineRow {
  return {
    id: m.id,
    name: m.name,
    company: m.company ?? null,
    line: m.line ?? null,
    notes: m.location ?? null,
    project_name: m.projectName,
    platform: m.platform,
    processor: m.processor ?? null,
    file_names: m.fileNames,
    size: m.size,
    export_version: exportVersion,
    added_at: iso(m.addedAt),
    updated_at: iso(m.editedAt ?? m.updatedAt),
  };
}

function detailsFromRow(r: MachineRow): Partial<Machine> {
  return {
    name: r.name,
    company: r.company ?? undefined,
    line: r.line ?? undefined,
    location: r.notes ?? undefined,
    projectName: r.project_name,
    platform: r.platform as Machine["platform"],
    processor: r.processor ?? undefined,
    editedAt: Date.parse(r.updated_at),
    cloudUpdatedAt: Date.parse(r.updated_at),
  };
}

async function uploadFiles(m: Machine): Promise<void> {
  const sb = await supabase();
  const id = uid();
  const keep = new Set<string>();
  for (let i = 0; i < m.files.length; i++) {
    const f = m.files[i]!;
    const path = exportPath(id, m.id, i, f.name);
    keep.add(path.split("/").pop()!);
    setCloudState({ progress: `Uploading ${f.name}…` });
    const { error } = await sb.storage.from(BUCKET).upload(path, await gzipText(f.text), { upsert: true, contentType: "application/gzip" });
    if (error) throw new Error(`Upload of ${f.name} failed: ${error.message}`);
  }
  // Remove files from an older export.
  const { data } = await sb.storage.from(BUCKET).list(`${id}/${m.id}/export`);
  const stale = (data ?? []).filter((o) => !keep.has(o.name)).map((o) => `${id}/${m.id}/export/${o.name}`);
  if (stale.length) await sb.storage.from(BUCKET).remove(stale);
}

/** Send one machine's details (and its files when they changed). */
async function pushMachine(m: Machine, row: MachineRow | undefined): Promise<void> {
  const sb = await supabase();
  const withFiles = !row || !!m.filesDirty;
  const version = withFiles ? (row?.export_version ?? 0) + 1 : (row?.export_version ?? m.exportVersion ?? 1);
  if (withFiles) {
    if (m.remote || !m.files.length) return; // nothing to upload from here
    await uploadFiles(m);
  }
  const next = toRow(m, version);
  const { error } = await sb.from("machines").upsert(next);
  if (error) throw new Error(`Saving ${m.name} failed: ${error.message}`);
  const now = Date.now();
  await putMachine({ ...m, exportVersion: version, syncedAt: now, cloudUpdatedAt: Date.parse(next.updated_at), dirty: false, filesDirty: false });
}

/** Download a cloud machine's export files to this device. */
export async function downloadMachineFiles(m: Machine): Promise<Machine> {
  if (!getCloudState().user) throw new Error(`${m.name} is in your cloud library. Sign in to download it.`);
  const sb = await supabase();
  const id = uid();
  const { data: row, error } = await sb.from("machines").select("*").eq("id", m.id).maybeSingle<MachineRow>();
  if (error) throw new Error(error.message);
  if (!row) throw new Error(`${m.name} is no longer in your cloud library.`);
  const files: InputFile[] = [];
  for (let i = 0; i < row.file_names.length; i++) {
    const name = row.file_names[i]!;
    setCloudState({ progress: `Downloading ${name}…` });
    const { data, error: err } = await sb.storage.from(BUCKET).download(exportPath(id, m.id, i, name));
    if (err || !data) throw new Error(`Couldn't download ${name}: ${err?.message ?? "no data"}`);
    files.push({ name, text: await gunzipText(data) });
  }
  setCloudState({ progress: undefined });
  const next: Machine = {
    ...m,
    ...detailsFromRow(row),
    fileNames: row.file_names,
    size: row.size,
    files,
    remote: false,
    exportVersion: row.export_version,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
  };
  await putMachine(next);
  return next;
}

/** Make sure a machine's export is on this device (downloading it if needed). */
export async function ensureMachineFiles(m: Machine): Promise<Machine> {
  return m.remote || !m.files.length ? downloadMachineFiles(m) : m;
}

async function deleteMachineCloud(id: string): Promise<void> {
  const sb = await supabase();
  const owner = uid();
  for (const folder of ["export", "attachments"]) {
    const { data } = await sb.storage.from(BUCKET).list(`${owner}/${id}/${folder}`, { limit: 1000 });
    const paths = (data ?? []).map((o) => `${owner}/${id}/${folder}/${o.name}`);
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
  }
  await sb.from("machines").delete().eq("id", id);
  await sb.from("notes").delete().eq("scope", `alarm:${id}`);
}

/** If a different account signs in, nothing on this device counts as synced with it. */
async function checkOwner(id: string): Promise<void> {
  let last: string | null = null;
  try {
    last = localStorage.getItem(OWNER_KEY);
  } catch {
    // ignore
  }
  if (last === id) return;
  for (const m of await listMachinesFull()) {
    if (m.remote) await deleteMachineLocal(m.id); // belonged to the other account
    else {
      const { syncedAt: _s, cloudUpdatedAt: _c, ...rest } = m;
      await putMachine({ ...rest, dirty: true, filesDirty: true });
      for (const a of await listAttachments(m.id)) {
        const { syncedAt: _a, ...ra } = a;
        await putAttachment(ra);
      }
    }
  }
  setPendingDeletes({ machines: [], attachments: [] });
  try {
    localStorage.setItem(OWNER_KEY, id);
  } catch {
    // ignore
  }
}

/** Two-way sync of the machine list. Returns true when the local library changed. */
async function syncMachines(): Promise<boolean> {
  const sb = await supabase();
  let changed = false;

  // Deletes made here while offline.
  const pending = pendingDeletes();
  for (const id of pending.machines) await deleteMachineCloud(id);
  if (pending.machines.length) setPendingDeletes({ ...pendingDeletes(), machines: [] });

  const { data, error } = await sb.from("machines").select("*");
  if (error) throw new Error(error.message);
  const rows = new Map((data as MachineRow[]).map((r) => [r.id, r]));
  const local = await listMachinesFull();
  const localIds = new Set(local.map((m) => m.id));

  for (const m of local) {
    const row = rows.get(m.id);
    if (!row) {
      if (m.syncedAt && !m.dirty && !m.filesDirty) {
        await deleteMachineLocal(m.id); // deleted on another device
        kvDrop(`alarm:${m.id}`);
        changed = true;
      } else {
        await pushMachine(m, undefined);
      }
      continue;
    }
    const cloudAt = Date.parse(row.updated_at);
    const cloudChanged = cloudAt > (m.cloudUpdatedAt ?? 0);
    const newerFiles = row.export_version > (m.exportVersion ?? 0) && !m.filesDirty;
    if (m.filesDirty || (m.dirty && (!cloudChanged || (m.editedAt ?? 0) >= cloudAt))) {
      await pushMachine(m, row);
    } else if (cloudChanged || newerFiles) {
      const patch: Partial<Machine> = { ...detailsFromRow(row), syncedAt: Date.now(), dirty: false };
      if (newerFiles) {
        // A newer export was uploaded elsewhere: fetch it on next open.
        Object.assign(patch, { files: [], remote: true, fileNames: row.file_names, size: row.size, updatedAt: Date.now() });
      }
      await putMachine({ ...m, ...patch });
      changed = true;
    } else if (!m.syncedAt) {
      await putMachine({ ...m, syncedAt: Date.now() });
    }
  }

  for (const row of rows.values()) {
    if (localIds.has(row.id)) continue;
    const now = Date.now();
    await putMachine({
      id: row.id,
      ...(detailsFromRow(row) as Pick<Machine, "name" | "projectName" | "platform">),
      fileNames: row.file_names,
      size: row.size,
      addedAt: Date.parse(row.added_at),
      updatedAt: now,
      files: [],
      remote: true,
      exportVersion: row.export_version,
      syncedAt: now,
    });
    changed = true;
  }
  return changed;
}

/* -------------------------------- attachments -------------------------------- */

/**
 * Sync one machine's drawings. Returns true when the local list changed.
 * Without `download`, only uploads what's new here (used for the whole library).
 */
export async function syncAttachments(machineId: string, download = true): Promise<boolean> {
  if (!getCloudState().user) return false;
  const sb = await supabase();
  const owner = uid();
  let changed = false;

  const pending = pendingDeletes();
  if (pending.attachments.length) {
    const { data: gone } = await sb.from("attachments").select("id, storage_path").in("id", pending.attachments);
    const paths = (gone ?? []).map((g) => (g as { storage_path: string }).storage_path);
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    await sb.from("attachments").delete().in("id", pending.attachments);
    setPendingDeletes({ ...pendingDeletes(), attachments: [] });
  }

  const machine = await getMachine(machineId);
  if (!machine || machine.dirty || machine.filesDirty || !machine.syncedAt) return false; // machine row must exist first
  const { data, error } = await sb.from("attachments").select("*").eq("machine_id", machineId);
  if (error) throw new Error(error.message);
  const rows = new Map((data as AttachmentRow[]).map((r) => [r.id, r]));
  const local = await listAttachments(machineId);

  for (const a of local) {
    if (rows.has(a.id)) continue;
    if (a.syncedAt) {
      await deleteAttachmentLocal(a.id); // removed on another device
      changed = true;
      continue;
    }
    const path = attachmentPath(owner, a);
    setCloudState({ progress: `Uploading ${a.name}…` });
    const up = await sb.storage.from(BUCKET).upload(path, a.blob, { upsert: true, contentType: a.mime });
    if (up.error) throw new Error(`Upload of ${a.name} failed: ${up.error.message}`);
    const { error: e2 } = await sb.from("attachments").upsert({
      id: a.id,
      machine_id: machineId,
      kind: a.kind,
      name: a.name,
      mime: a.mime,
      size: a.size,
      page_count: a.pageCount ?? null,
      pages_text: a.pagesText ?? null,
      storage_path: path,
      created_at: iso(a.addedAt),
    });
    if (e2) throw new Error(`Saving ${a.name} failed: ${e2.message}`);
    await putAttachment({ ...a, syncedAt: Date.now() });
  }

  const localIds = new Set(local.map((a) => a.id));
  for (const r of rows.values()) {
    if (localIds.has(r.id) || !download) continue;
    setCloudState({ progress: `Downloading ${r.name}…` });
    const { data: blob, error: e3 } = await sb.storage.from(BUCKET).download(r.storage_path);
    if (e3 || !blob) continue;
    await putAttachment({
      id: r.id,
      machineId,
      kind: r.kind,
      name: r.name,
      mime: r.mime,
      size: r.size,
      ...(r.page_count ? { pageCount: r.page_count } : {}),
      ...(r.pages_text ? { pagesText: r.pages_text } : {}),
      addedAt: Date.parse(r.created_at),
      blob: new Blob([blob], { type: r.mime }),
      syncedAt: Date.now(),
    });
    changed = true;
  }
  setCloudState({ progress: undefined });
  return changed;
}

/* ----------------------------------- notes ----------------------------------- */

async function syncNotes(): Promise<void> {
  const sb = await supabase();
  const { data, error } = await sb.from("notes").select("scope, key, value, updated_at");
  if (error) throw new Error(error.message);
  const remote = new Map<string, Record<string, KvEntry>>();
  for (const r of data as { scope: string; key: string; value: unknown; updated_at: string }[]) {
    const scope = remote.get(r.scope) ?? {};
    scope[r.key] = { v: r.value, t: Date.parse(r.updated_at) };
    remote.set(r.scope, scope);
  }
  for (const [scope, entries] of remote) kvMerge(scope, entries);

  const upserts: { scope: string; key: string; value: unknown; updated_at: string }[] = [];
  for (const scope of new Set([...kvScopes(), ...remote.keys()])) {
    const theirs = remote.get(scope) ?? {};
    for (const [key, e] of Object.entries(kvEntries(scope))) {
      const r = theirs[key];
      if (!r || e.t > r.t) upserts.push({ scope, key, value: e.v ?? null, updated_at: iso(e.t) });
    }
  }
  for (let i = 0; i < upserts.length; i += 500) {
    const { error: e2 } = await sb.from("notes").upsert(upserts.slice(i, i + 500));
    if (e2) throw new Error(e2.message);
  }
}

/* ---------------------------------- driver ---------------------------------- */

let running: Promise<boolean> | null = null;
let again = false;
let onChange: (() => void) | undefined;
let onDrawings: ((machineId: string) => void) | undefined;

/** Called when sync changed the local library (so the UI reloads it). */
export function onSyncChange(fn: () => void): void {
  onChange = fn;
}

/** Called when a machine's drawings changed in the background. */
export function onDrawingsChange(fn: (machineId: string) => void): void {
  onDrawings = fn;
}

let prefetching = false;

/**
 * Like any web app: once signed in, every machine (its export and drawings)
 * comes down to this device in the background, so it's all there — offline too.
 */
async function prefetchAll(): Promise<void> {
  if (prefetching || !getCloudState().user || !navigator.onLine) return;
  prefetching = true;
  try {
    const todo = (await listMachinesFull()).filter((m) => m.remote || !m.files.length);
    for (let i = 0; i < todo.length; i++) {
      if (!getCloudState().user) return;
      setCloudState({ syncing: true, progress: `Downloading machines — ${i + 1} of ${todo.length}` });
      try {
        await downloadMachineFiles(todo[i]!);
        onChange?.();
      } catch {
        // try again on the next sync
      }
    }
    const all = await listMachinesFull();
    for (let i = 0; i < all.length; i++) {
      if (!getCloudState().user) return;
      setCloudState({ syncing: true, progress: `Checking drawings — ${i + 1} of ${all.length}` });
      try {
        if (await syncAttachments(all[i]!.id, true)) onDrawings?.(all[i]!.id);
      } catch {
        // next time
      }
    }
  } finally {
    prefetching = false;
    setCloudState({ syncing: false, progress: undefined });
  }
}

/** Full sync now. Concurrent calls share one run (and queue one more). */
export function syncNow(): Promise<boolean> {
  const user = getCloudState().user;
  if (!user || !navigator.onLine) return Promise.resolve(false);
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    setCloudState({ syncing: true, error: undefined });
    let changed = false;
    try {
      await checkOwner(user.id);
      changed = await syncMachines();
      await syncNotes();
      // Upload drawings added on this device (downloads happen when a machine is opened).
      for (const m of await listMachinesFull()) {
        if ((await listAttachments(m.id)).some((a) => !a.syncedAt)) await syncAttachments(m.id, false);
      }
      setCloudState({ lastSync: Date.now() });
    } catch (err) {
      setCloudState({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setCloudState({ syncing: false, progress: undefined });
      running = null;
    }
    if (changed) onChange?.();
    if (again) {
      again = false;
      void syncNow();
    } else {
      void prefetchAll();
    }
    return changed;
  })();
  return running;
}

let timer: number | undefined;
/** Sync a moment after a local change (edits come in bursts). */
export function requestSync(delay = 1500): void {
  if (!getCloudState().user) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow(), delay);
}

setKvListener(() => requestSync(3000));
