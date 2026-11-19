import { normalizeName, type CommLink, type LinkDirection } from "@core/logic/connectivity";
import type { MachineInsights, MachineSummary } from "./machines";
import { kvSet } from "./kv";

/* ------------------------------ endpoint links ------------------------------ */

/**
 * Your own answers to "which machine is this?" for message targets the tool
 * couldn't match by IP or name: endpoint key → machine id (synced as notes).
 */
export function saveEndpointLink(endpoint: string, machineId: string | null): void {
  kvSet("links", endpoint, machineId);
}

/* ---------------------------------- graph ----------------------------------- */

export interface NetNode {
  id: string;
  kind: "machine" | "endpoint";
  label: string;
  sub?: string;
  machine?: MachineSummary;
  endpoint?: string;
  address?: string;
  /** Machines that talk to this (unknown) endpoint. */
  seenBy?: string[];
}

export interface NetItem {
  /** Machine whose program holds the message. */
  from: string;
  link: CommLink;
  /** How the far end was recognised. */
  match: "manual" | "ip" | "name" | "none";
}

export interface NetEdge {
  id: string;
  a: string;
  b: string;
  items: NetItem[];
  /** Data flows a → b / b → a. */
  ab: boolean;
  ba: boolean;
  unknownDir: boolean;
}

export interface Network {
  nodes: NetNode[];
  edges: NetEdge[];
}

export interface NetworkOptions {
  showLocal: boolean;
  showIsolated: boolean;
  company?: string;
}

const flows = (dir: LinkDirection): { out: boolean; in: boolean } =>
  dir === "send" ? { out: true, in: false } : dir === "receive" ? { out: false, in: true } : dir === "both" ? { out: true, in: true } : { out: false, in: false };

export function buildNetwork(
  machines: MachineSummary[],
  insights: Map<string, MachineInsights>,
  manual: Record<string, string>,
  opts: NetworkOptions,
): Network {
  const inScope = machines.filter((m) => !opts.company || (m.company?.trim() ?? "") === opts.company);
  const byIp = new Map<string, MachineSummary>();
  const byName = new Map<string, MachineSummary>();
  for (const m of machines) {
    const i = insights.get(m.id);
    for (const ip of i?.comms.ips ?? []) byIp.set(ip, m);
    for (const n of [m.name, m.projectName, ...(i?.comms.names ?? [])]) if (n) byName.set(normalizeName(n), m);
  }
  const machineById = new Map(machines.map((m) => [m.id, m]));

  const nodes = new Map<string, NetNode>();
  const edges = new Map<string, NetEdge>();
  const machineNode = (m: MachineSummary) => {
    const id = `m:${m.id}`;
    if (!nodes.has(id)) {
      const sub = [m.line, m.company].filter(Boolean).join(" · ");
      nodes.set(id, { id, kind: "machine", label: m.name, machine: m, ...(sub ? { sub } : {}) });
    }
    return id;
  };

  for (const m of inScope) {
    const comms = insights.get(m.id)?.comms;
    if (opts.showIsolated) machineNode(m);
    if (!comms) continue;
    for (const link of comms.links) {
      if (link.local && !opts.showLocal) continue;
      const ip = link.endpoint.startsWith("ip:") ? link.endpoint.slice(3) : undefined;
      let target: MachineSummary | undefined;
      let match: NetItem["match"] = "none";
      const manualId = manual[link.endpoint];
      if (manualId && machineById.has(manualId)) {
        target = machineById.get(manualId);
        match = "manual";
      } else if (ip && byIp.get(ip) && byIp.get(ip)!.id !== m.id) {
        target = byIp.get(ip);
        match = "ip";
      } else {
        const t = byName.get(normalizeName(link.remoteName)) ?? (link.endpoint.startsWith("name:") ? byName.get(link.endpoint.slice(5)) : undefined);
        if (t && t.id !== m.id) {
          target = t;
          match = "name";
        }
      }
      if (target?.id === m.id) continue;
      const a = machineNode(m);
      let b: string;
      if (target) b = machineNode(target);
      else {
        b = `e:${link.endpoint}`;
        const node = nodes.get(b) ?? {
          id: b,
          kind: "endpoint" as const,
          label: link.remoteName,
          endpoint: link.endpoint,
          seenBy: [],
          ...(link.remoteAddress ? { address: link.remoteAddress.replace(/\?port=.*/, "") } : {}),
        };
        if (!node.seenBy!.includes(m.id)) node.seenBy!.push(m.id);
        nodes.set(b, node);
      }
      const [x, y] = a < b ? [a, b] : [b, a];
      const id = `${x}|${y}`;
      const edge = edges.get(id) ?? { id, a: x, b: y, items: [], ab: false, ba: false, unknownDir: false };
      edge.items.push({ from: m.id, link, match });
      const f = flows(link.direction);
      const forward = a === x;
      if (f.out) forward ? (edge.ab = true) : (edge.ba = true);
      if (f.in) forward ? (edge.ba = true) : (edge.ab = true);
      if (!f.out && !f.in) edge.unknownDir = true;
      edges.set(id, edge);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/* ---------------------------------- layout ---------------------------------- */

export interface Point {
  x: number;
  y: number;
}

/** Force-directed layout of one connected group, centred on 0,0. */
function layoutComponent(nodes: NetNode[], edges: NetEdge[]): Map<string, Point> {
  const n = nodes.length;
  const pos = new Map<string, Point>();
  if (n === 1) {
    pos.set(nodes[0]!.id, { x: 0, y: 0 });
    return pos;
  }
  const machines = nodes.filter((x) => x.kind === "machine");
  const ring = 90 + 30 * Math.sqrt(n);
  machines.forEach((m, i) => {
    const t = (2 * Math.PI * i) / Math.max(1, machines.length);
    pos.set(m.id, machines.length === 1 ? { x: 0, y: 0 } : { x: Math.cos(t) * ring * 0.5, y: Math.sin(t) * ring * 0.5 });
  });
  // Endpoints start around the first machine that talks to them.
  const neighbor = new Map<string, string>();
  for (const e of edges) {
    if (!neighbor.has(e.b)) neighbor.set(e.b, e.a);
    if (!neighbor.has(e.a)) neighbor.set(e.a, e.b);
  }
  nodes.forEach((node, i) => {
    if (pos.has(node.id)) return;
    const anchor = pos.get(neighbor.get(node.id) ?? "") ?? { x: 0, y: 0 };
    const t = i * 2.399963; // golden angle spreads siblings
    pos.set(node.id, { x: anchor.x + Math.cos(t) * 200, y: anchor.y + Math.sin(t) * 120 });
  });

  const ids = nodes.map((x) => x.id);
  const k = 170;
  let temp = 50;
  for (let iter = 0; iter < 300; iter++) {
    const disp = new Map(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const p = pos.get(ids[i]!)!;
        const q = pos.get(ids[j]!)!;
        // boxes are wide: weigh horizontal distance less so labels don't overlap
        let dx = (p.x - q.x) * 0.6;
        let dy = p.y - q.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) {
          dx = 0.1 * (i - j);
          dy = 0.1;
          d = Math.hypot(dx, dy);
        }
        const f = (k * k) / d;
        const di = disp.get(ids[i]!)!;
        const dj = disp.get(ids[j]!)!;
        di.x += (dx / d) * f;
        di.y += (dy / d) * f;
        dj.x -= (dx / d) * f;
        dj.y -= (dy / d) * f;
      }
    }
    for (const e of edges) {
      const p = pos.get(e.a)!;
      const q = pos.get(e.b)!;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = (d * d) / k;
      const da = disp.get(e.a)!;
      const db = disp.get(e.b)!;
      da.x -= (dx / d) * f;
      da.y -= (dy / d) * f;
      db.x += (dx / d) * f;
      db.y += (dy / d) * f;
    }
    for (const id of ids) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      d.x -= p.x * 0.08;
      d.y -= p.y * 0.08;
      const len = Math.max(0.01, Math.hypot(d.x, d.y));
      p.x += (d.x / len) * Math.min(len, temp);
      p.y += (d.y / len) * Math.min(len, temp);
    }
    temp = Math.max(1, temp * 0.98);
  }
  // re-centre
  const cx = [...pos.values()].reduce((a, p) => a + p.x, 0) / n;
  const cy = [...pos.values()].reduce((a, p) => a + p.y, 0) / n;
  for (const p of pos.values()) {
    p.x -= cx;
    p.y -= cy;
  }
  return pos;
}

/** Lay out each connected group on its own, then pack the groups in rows (biggest first). */
export function layoutNetwork(net: Network): Map<string, Point> {
  const pos = new Map<string, Point>();
  if (!net.nodes.length) return pos;
  const adj = new Map<string, string[]>(net.nodes.map((n) => [n.id, []]));
  for (const e of net.edges) {
    adj.get(e.a)?.push(e.b);
    adj.get(e.b)?.push(e.a);
  }
  const seen = new Set<string>();
  const comps: NetNode[][] = [];
  const byId = new Map(net.nodes.map((n) => [n.id, n]));
  for (const n of net.nodes) {
    if (seen.has(n.id)) continue;
    const comp: NetNode[] = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(byId.get(id)!);
      for (const next of adj.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    comps.push(comp);
  }
  comps.sort((a, b) => b.length - a.length);

  const pad = 120;
  const laid = comps.map((comp) => {
    const ids = new Set(comp.map((c) => c.id));
    const local = layoutComponent(
      comp,
      net.edges.filter((e) => ids.has(e.a) && ids.has(e.b)),
    );
    const xs = [...local.values()].map((p) => p.x);
    const ys = [...local.values()].map((p) => p.y);
    return { local, minX: Math.min(...xs), minY: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs) + 180, h: Math.max(...ys) - Math.min(...ys) + 60 };
  });
  const total = laid.reduce((a, c) => a + (c.w + pad) * (c.h + pad), 0);
  const rowWidth = Math.max(laid[0]!.w, Math.sqrt(total) * 1.5);
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const c of laid) {
    if (x > 0 && x + c.w > rowWidth) {
      x = 0;
      y += rowH + pad;
      rowH = 0;
    }
    for (const [id, p] of c.local) pos.set(id, { x: x + (p.x - c.minX) + 90, y: y + (p.y - c.minY) + 30 });
    x += c.w + pad;
    rowH = Math.max(rowH, c.h);
  }
  return pos;
}
