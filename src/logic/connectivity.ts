/**
 * Who this machine talks to: MSG instructions, Logix MESSAGE tags, sockets,
 * and produced / consumed tags. Each link names its far end as well as the
 * export allows — an IP address when there is one, otherwise the name the
 * logic uses (rung title, tag description, producer module).
 */

import type { CrossReferenceHit, ModuleNode, RoutineRef, SavedValue, TagRecord } from "../model/types.js";
import { walkInstructions } from "../ladder/parse.js";
import type { ProjectIndex } from "../query/index.js";
import { parseClassicAddress } from "./refs.js";

export type LinkDirection = "send" | "receive" | "both" | "unknown";
export type LinkKind = "msg" | "socket" | "produced" | "consumed";

export interface CommLink {
  kind: LinkKind;
  /** From this machine's point of view. */
  direction: LinkDirection;
  /** Stable id of the far end: `ip:192.168.1.20` or `name:asrs plc`. */
  endpoint: string;
  /** What the far end is called, as best the export says. */
  remoteName: string;
  remoteAddress?: string;
  remoteCatalog?: string;
  /** The far end is this machine's own backplane or a device in its own I/O tree. */
  local?: boolean;
  /** MSG control tag / block, or the produced / consumed tag. */
  tag: string;
  /** Short what-it-does line, e.g. "SLC Typed Write → N33:0". */
  detail: string;
  localData?: string;
  remoteData?: string;
  path?: string;
  description?: string;
  /** First rung that uses it. */
  at?: { where: RoutineRef; rung: number };
}

export interface MachineComms {
  /** IP addresses of this controller's own Ethernet ports (to match other machines' targets). */
  ips: string[];
  /** Names other machines might use for this one. */
  names: string[];
  links: CommLink[];
}

const IP = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const firstLine = (s?: string) =>
  s
    ?.split(/\n|\s{3,}/)
    .map((x) => x.trim())
    .find(Boolean);

/** "*** ASRS PLC COMMMUNICATION ***" → "ASRS PLC". */
export function cleanEndpointName(s: string): string {
  return s
    .replace(/[*#=_~-]{2,}/g, " ")
    .replace(/\b(com+unications?|comms?|msg|messages?|data exchange|signal exchange)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s:,.;-]+|[\s:,.;-]+$/g, "")
    .trim()
    .replace(/^[^A-Za-z0-9]*$/, "");
}

function endpointKey(address: string | undefined, name: string): string {
  return address && IP.test(address) ? `ip:${address.match(IP)![1]}` : `name:${normalizeName(name)}`;
}

/** "Electrical Data / From PowerMonitor / Message Command 14" → "PowerMonitor". */
function partnerOf(description?: string): string | undefined {
  const lines = (description ?? "").split("\n").map((l) => l.trim());
  const hit = lines.map((l) => l.match(/^(?:from|to)\s+(.{3,})$/i)?.[1]).find(Boolean);
  const name = cleanEndpointName(hit ?? firstLine(description) ?? "");
  return name || undefined;
}

/* ---------------------------------- modules ---------------------------------- */

function flatModules(mods: ModuleNode[]): ModuleNode[] {
  return mods.flatMap((m) => [m, ...flatModules(m.children)]);
}

function ipOf(m: ModuleNode | undefined): string | undefined {
  return m?.address?.match(IP)?.[1];
}

/** IPs of the Ethernet ports in the controller's own chassis. */
function ownIps(index: ProjectIndex): string[] {
  const all = flatModules(index.project.modules);
  const local = all.find((m) => m.name === "Local");
  const out = new Set<string>();
  for (const m of all) {
    const inLocalChassis = m === local || m.parent === "Local" || (local && m.parent === local.name);
    const ip = ipOf(m);
    if (inLocalChassis && ip) out.add(ip);
  }
  return [...out];
}

/* ------------------------------- saved values -------------------------------- */

/** Find an IP (and optional port) inside a saved value — strings, STRING structs or SINT arrays. */
function ipInValue(v: SavedValue | undefined, depth = 0): string | undefined {
  if (v === undefined || depth > 6) return undefined;
  if (typeof v === "string") return v.match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\?port=\d{1,5}|:\d{1,5})?/)?.[0];
  if (Array.isArray(v)) {
    if (v.length >= 7 && v.every((x) => typeof x === "number")) {
      const text = (v as number[]).map((n) => (n > 31 && n < 127 ? String.fromCharCode(n) : " ")).join("");
      const hit = ipInValue(text);
      if (hit) return hit;
    }
    for (const x of v) {
      const hit = ipInValue(x, depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof v === "object") {
    for (const x of Object.values(v)) {
      const hit = ipInValue(x, depth + 1);
      if (hit) return hit;
    }
  }
  return undefined;
}

/* ----------------------------------- Logix ----------------------------------- */

function serviceDirection(code?: string): LinkDirection | undefined {
  if (!code) return undefined;
  const n = parseInt(code.replace(/^16#/, "").replace(/_/g, ""), 16);
  if ([0x01, 0x03, 0x0e, 0x4c].includes(n)) return n === 0x4c ? undefined : "receive";
  if ([0x02, 0x04, 0x10].includes(n)) return "send";
  return undefined;
}

function wordDirection(text: string): LinkDirection | undefined {
  if (/\b(send|write|wr|out|to)\b|send|write/i.test(text)) return "send";
  if (/\b(receive|read|rd|in|from)\b|receive|read/i.test(text)) return "receive";
  return undefined;
}

/** "E9704_ForeignConveyor_M04" → "Foreign Conveyor". */
function nameFromRoutine(routine: string): string {
  return cleanEndpointName(
    routine
      .replace(/^_?[A-Z]?\d+_/, "")
      .replace(/_[A-Z]\d+$/, "")
      .replace(/_/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2"),
  );
}

function firstUse(index: ProjectIndex, t: TagRecord) {
  const owner = t.scope || index.project.programs[0]?.name || "";
  const info = index.resolve(t.name, { kind: "program", owner });
  const hits = index.hitsRelated(info.key, info.base);
  const hit = hits.find((h) => h.mnemonic.toUpperCase() === "MSG") ?? hits[0];
  return hit ? { where: { kind: hit.kind, owner: hit.owner, routine: hit.routine }, rung: hit.rung } : undefined;
}

function logixLinks(index: ProjectIndex): CommLink[] {
  const modules = flatModules(index.project.modules);
  const byName = new Map(modules.map((m) => [m.name.toUpperCase(), m]));
  const byIp = new Map(modules.filter((m) => ipOf(m)).map((m) => [ipOf(m)!, m]));
  const local = modules.find((m) => m.name === "Local");
  const isOwnComm = (m: ModuleNode | undefined) => !!m && (m.parent === "Local" || (!!local && m.parent === local.name));
  const links: CommLink[] = [];
  const sockets = new Map<string, CommLink[]>();

  const moduleLabel = (m: ModuleNode) => {
    const d = firstLine(m.description);
    return d && d.toUpperCase() !== m.name.toUpperCase() ? `${m.name} — ${d}` : m.name;
  };

  for (const t of index.project.tags) {
    const c = t.comm;
    if (!c) continue;
    const at = firstUse(index, t);
    const description = t.description?.replace(/\s*\n\s*/g, " · ");
    const base = { tag: t.scope ? `${t.scope}:${t.name}` : t.name, ...(description ? { description } : {}), ...(at ? { at } : {}) };

    if (c.MessageType) {
      const path = c.ConnectionPath ?? "";
      const segs = path.split(",").map((s) => s.trim()).filter(Boolean);
      const ipSeg = [...segs].reverse().find((s) => IP.test(s));
      const first = segs[0] && !/^\d+$/.test(segs[0]) ? byName.get(segs[0].toUpperCase()) : undefined;
      const isSocket = /^16#0*342$/i.test(c.ObjectType ?? "");
      const localData = c.DestinationTag ?? c.LocalElement;
      const msgDir =
        (/read/i.test(c.MessageType) ? "receive" : /write/i.test(c.MessageType) ? "send" : undefined) ??
        serviceDirection(c.ServiceCode) ??
        wordDirection(`${t.name} ${t.description ?? ""}`) ??
        "both";
      const detail = [c.MessageType, c.RemoteElement ? `→ ${c.RemoteElement}` : ""].filter(Boolean).join(" ");
      const common = {
        ...base,
        direction: msgDir as LinkDirection,
        detail,
        ...(localData ? { localData } : {}),
        ...(c.RemoteElement ? { remoteData: c.RemoteElement } : {}),
        ...(path ? { path } : {}),
      };

      if (isSocket) {
        // Socket messages go to the local Ethernet module; the far end is in the open request.
        const group = t.name.replace(/_?MSG(_?[A-Za-z]+)?$/i, "") || t.name;
        const name = cleanEndpointName(
          (firstLine(t.description) ?? "").replace(/\b(sockets?|create|open|close|delete|del|all|read|write|send|receive|data|buffer)\b/gi, " "),
        );
        const opened = c.LocalElement ? ipInValue(index.resolve(c.LocalElement, { kind: "program", owner: t.scope || "" }).value) : undefined;
        const verb = /open/i.test(t.name) ? "open" : /create/i.test(t.name) ? "create" : /delete|close/i.test(t.name) ? "close" : /send|write/i.test(t.name) ? "send" : /receive|read/i.test(t.name) ? "receive" : "message";
        const link: CommLink = {
          ...common,
          kind: "socket",
          direction: verb === "send" ? "send" : verb === "receive" ? "receive" : "both",
          detail: `Socket ${verb}`,
          endpoint: "",
          remoteName: name,
          ...(opened ? { remoteAddress: opened } : {}),
        };
        const list = sockets.get(group) ?? [];
        list.push(link);
        sockets.set(group, list);
        links.push(link);
        continue;
      }

      if (ipSeg) {
        const ip = ipSeg.match(IP)![1]!;
        const mod = byIp.get(ip);
        const ownDevice = !!mod && !isOwnComm(mod);
        const name = mod ? moduleLabel(mod) : (partnerOf(t.description) ?? (at ? nameFromRoutine(at.where.routine) : "") ?? ip) || ip;
        links.push({
          ...common,
          kind: "msg",
          endpoint: `ip:${ip}`,
          remoteName: name,
          remoteAddress: ip,
          ...(mod?.catalogNumber ? { remoteCatalog: mod.catalogNumber } : {}),
          ...(ownDevice ? { local: true } : {}),
        });
        continue;
      }

      // No IP in the path: a module in the I/O tree, the backplane, or a DH+/serial node.
      const lastName = [...segs].reverse().find((s) => !/^\d+$/.test(s));
      const target = lastName ? byName.get(lastName.toUpperCase()) : undefined;
      if (target && segs.length === 1) {
        links.push({
          ...common,
          kind: "msg",
          endpoint: ipOf(target) ? `ip:${ipOf(target)}` : `name:${normalizeName(target.name)}`,
          remoteName: moduleLabel(target),
          ...(ipOf(target) ? { remoteAddress: ipOf(target)! } : {}),
          ...(target.catalogNumber ? { remoteCatalog: target.catalogNumber } : {}),
          local: true,
        });
        continue;
      }
      if (/^\d+$/.test(segs[0] ?? "")) {
        // "1, 0" — out the backplane to a slot in this chassis.
        const slot = segs[segs.length - 1];
        const mod = modules.find((m) => (m.parent === "Local" || m.name === "Local") && m.slot === slot);
        links.push({
          ...common,
          kind: "msg",
          endpoint: `name:${normalizeName(`${index.project.name} backplane slot ${slot}`)}`,
          remoteName: mod ? `Slot ${slot}: ${mod.catalogNumber ?? mod.name}` : `Backplane slot ${slot}`,
          local: true,
        });
        continue;
      }
      // Through a module to a node number (DH+, DH-485, ControlNet…).
      const node = segs[segs.length - 1];
      const via = first ? first.name : segs[0] ?? "";
      const name = partnerOf(t.description) ?? `${via} node ${node}`;
      links.push({
        ...common,
        kind: "msg",
        endpoint: `name:${normalizeName(name)}`,
        remoteName: name,
        ...(node && via ? { remoteAddress: `${via} › node ${node}` } : {}),
      });
      continue;
    }

    if (c.Producer || c.TagType === "Consumed") {
      const producer = c.Producer ? byName.get(c.Producer.toUpperCase()) : undefined;
      const parent = producer?.parent ? byName.get(producer.parent.toUpperCase()) : undefined;
      const ip = ipOf(producer) ?? ipOf(parent);
      const name = producer ? moduleLabel(producer) : (c.Producer ?? "Unknown producer");
      links.push({
        ...base,
        kind: "consumed",
        direction: "receive",
        detail: `Consumes ${c.RemoteTag ?? c.RemoteFile ?? "a produced tag"}`,
        endpoint: endpointKey(ip, c.Producer ?? name),
        remoteName: name,
        ...(ip ? { remoteAddress: ip } : {}),
        ...(producer?.catalogNumber ? { remoteCatalog: producer.catalogNumber } : {}),
        ...(c.RemoteTag ? { remoteData: c.RemoteTag } : {}),
      });
      continue;
    }

    if (c.ProduceCount && Number(c.ProduceCount) > 0) {
      const guess = cleanEndpointName(
        (t.description ?? "")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /^to\b/i.test(l))
          ?.replace(/^to\s+/i, "") ?? "",
      );
      const name = guess || `Consumers of ${t.name}`;
      links.push({
        ...base,
        kind: "produced",
        direction: "send",
        detail: `Produces ${t.name} (up to ${c.ProduceCount} consumer${c.ProduceCount === "1" ? "" : "s"})`,
        endpoint: `name:${normalizeName(name)}`,
        remoteName: name,
        localData: t.name,
      });
    }
  }

  // Sockets: one far end per group (create / open / send / receive / close);
  // the open request carries its address.
  for (const [group, list] of sockets) {
    const counts = new Map<string, number>();
    for (const l of list) if (l.remoteName) counts.set(l.remoteName, (counts.get(l.remoteName) ?? 0) + 1);
    const name = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? group.replace(/^_+/, "");
    const addr = list.find((l) => l.remoteAddress)?.remoteAddress;
    const ip = addr?.match(IP)?.[1];
    const mod = ip ? byIp.get(ip) : undefined;
    // No open request in the group: housekeeping on our own Ethernet module (e.g. "delete all sockets").
    const housekeeping = !list.some((l) => /open/i.test(l.detail));
    for (const l of list) {
      if (housekeeping) l.local = true;
      l.remoteName = mod ? moduleLabel(mod) : name;
      l.endpoint = ip ? `ip:${ip}` : `name:${normalizeName(name)}`;
      if (addr) l.remoteAddress = addr;
      if (mod && !isOwnComm(mod)) l.local = true;
    }
  }
  return links;
}

/* ------------------------------- PLC-5 / SLC ------------------------------- */

const ADDRESS = /^[A-Z]{1,3}\d*:\d+(\.\d+)?(\/\d+)?$/i;

function classicLinks(index: ProjectIndex): CommLink[] {
  const project = index.project;
  const links: CommLink[] = [];
  const symbolsByFile = new Map<string, string[]>();
  for (const s of project.symbols) {
    const file = parseClassicAddress(s.address)?.file;
    const d = s.description?.replace(/\s+/g, " ").trim();
    if (!file || !d) continue;
    const list = symbolsByFile.get(file) ?? [];
    list.push(d);
    symbolsByFile.set(file, list);
  }
  /** The words most descriptions in a data file start with, e.g. "ACCUMIX INTERLOCK". */
  const dominant = (file: string) => {
    const descs = symbolsByFile.get(file) ?? [];
    if (descs.length < 2) return undefined;
    for (let k = 4; k >= 1; k--) {
      const counts = new Map<string, number>();
      for (const d of descs) {
        const words = d.split(" ");
        if (words.length < k) continue;
        const prefix = words.slice(0, k).join(" ");
        counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= Math.max(2, descs.length * 0.5) && best[0].length >= 4) return best[0];
    }
    return undefined;
  };

  // Every use of a data-table element, bits and members included: "N31:60" → hits.
  const hitsByElement = new Map<string, CrossReferenceHit[]>();
  for (const e of project.crossReference) {
    const a = parseClassicAddress(e.key);
    if (!a || a.element === undefined) continue;
    const k = `${a.file}:${a.element}`;
    const list = hitsByElement.get(k) ?? [];
    list.push(...e.hits);
    hitsByElement.set(k, list);
  }

  for (const program of project.programs) {
    for (const routine of program.routines) {
      routine.rungs.forEach((rung, i) => {
        if (!rung.ladder) return;
        walkInstructions(rung.ladder, (ins) => {
          if (ins.mnemonic.toUpperCase() !== "MSG") return;
          const ops = ins.operands;
          const addrs = ops.filter((o) => ADDRESS.test(o));
          const control = addrs[0] ?? ops[0] ?? "MSG";
          const localData = addrs[1];
          const remoteData = addrs[2];
          const joined = ops.join(" ");
          const path = joined.match(/MultiHop\(\s*(.*?)\s*\)/i)?.[1];
          const ip = (path ?? joined).match(IP)?.[1];
          const where: RoutineRef = { kind: "program", owner: program.name, routine: routine.name };

          // Name: control block description → the data file's common description → nearby rung title.
          let title: string | undefined;
          for (let k = i; k >= Math.max(0, i - 4) && !title; k--) {
            const r = routine.rungs[k]!;
            title = firstLine(r.title) ?? (k === i ? firstLine(r.comment) : undefined);
          }
          const file = parseClassicAddress(control)?.file;
          const controlDesc = firstLine(index.resolve(control, { kind: "program", owner: program.name }).description);
          const raw = controlDesc ?? (file ? dominant(file) : undefined) ?? title;
          const name = (raw && cleanEndpointName(raw)) || (ip ? `Node ${ip}` : `MSG ${control} target`);

          // Direction from how the logic uses the local data: written here → we send it.
          let direction: LinkDirection = "unknown";
          if (localData) {
            const a = parseClassicAddress(localData);
            const size = Number(ops[ops.indexOf(remoteData ?? "") + 1]) || 1;
            if (a && a.element !== undefined) {
              let writes = 0;
              let reads = 0;
              for (let e = a.element; e < a.element + Math.min(size, 256); e++) {
                for (const hit of hitsByElement.get(`${a.file}:${e}`) ?? []) {
                  if (hit.mnemonic.toUpperCase() === "MSG") continue;
                  if (hit.access === "write") writes++;
                  else reads++;
                }
              }
              direction = writes ? "send" : reads ? "receive" : "unknown";
            }
          }
          const desc = [rung.title, rung.comment].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
          links.push({
            kind: "msg",
            direction,
            endpoint: endpointKey(ip, name),
            remoteName: name,
            ...(ip ? { remoteAddress: ip } : {}),
            tag: control,
            detail: [
              "MSG",
              localData ? `local ${localData}` : "",
              remoteData ? `↔ remote ${remoteData}` : "",
              !ip && !path ? "(target not stated in the export)" : "",
            ]
              .filter(Boolean)
              .join(" "),
            ...(localData ? { localData } : {}),
            ...(remoteData ? { remoteData } : {}),
            ...(path ? { path } : {}),
            ...(desc ? { description: desc.slice(0, 200) } : {}),
            at: { where, rung: rung.index },
          });
        });
      });
    }
  }
  return links;
}

/* ---------------------------------------------------------------------------- */

export function machineComms(index: ProjectIndex): MachineComms {
  const p = index.project;
  const links = index.isLogix ? logixLinks(index) : classicLinks(index);
  // A produced tag named after a partner we also message by IP is the same partner.
  const byName = new Map<string, CommLink>();
  for (const l of links) if (l.endpoint.startsWith("ip:") && !l.local) byName.set(normalizeName(l.remoteName), l);
  for (const l of links) {
    if (l.kind !== "produced" && l.kind !== "consumed") continue;
    const twin = byName.get(normalizeName(l.remoteName));
    if (twin && l.endpoint.startsWith("name:")) {
      l.endpoint = twin.endpoint;
      if (twin.remoteAddress) l.remoteAddress = twin.remoteAddress;
    }
  }
  const names = [...new Set([p.name, p.controller.name].filter(Boolean).map(normalizeName))];
  return { ips: index.isLogix ? ownIps(index) : [], names, links };
}

/** Links grouped by far end, for lists. */
export function groupByEndpoint(links: CommLink[]): { endpoint: string; name: string; address?: string; local: boolean; links: CommLink[] }[] {
  const map = new Map<string, { endpoint: string; name: string; address?: string; local: boolean; links: CommLink[] }>();
  for (const l of links) {
    let g = map.get(l.endpoint);
    if (!g) {
      g = { endpoint: l.endpoint, name: l.remoteName, local: !!l.local, links: [], ...(l.remoteAddress ? { address: l.remoteAddress } : {}) };
      map.set(l.endpoint, g);
    }
    g.links.push(l);
  }
  return [...map.values()].sort((a, b) => Number(a.local) - Number(b.local) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}
