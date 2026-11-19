import { useMemo, useState } from "react";
import type { DataFile, ProjectModel } from "@core/model/types";
import { formatClassicAddress } from "@core/logic/refs";
import type { ProjectIndex } from "@core/query/index";
import type { Selection } from "../lib/nav";

const STRUCT_BITS: Record<string, [string, number][]> = {
  T: [["EN", 15], ["TT", 14], ["DN", 13]],
  C: [["CU", 15], ["CD", 14], ["DN", 13], ["OV", 12], ["UN", 11]],
  R: [["EN", 15], ["EU", 14], ["DN", 13], ["EM", 12], ["ER", 11], ["UL", 10], ["IN", 9], ["FD", 8]],
  BT: [["EN", 15], ["ST", 14], ["DN", 13], ["ER", 12], ["CO", 11], ["EW", 10], ["NR", 9], ["TO", 8]],
};

const BIT_FILES = new Set(["B", "I", "O"]);

/** SLC I/O files are per slot ("I:2"); PLC-5 has one I/O image ("I"). */
const slotOf = (file: DataFile) => (file.name.includes(":") && file.number !== undefined ? { slot: file.number } : {});

function wordAddress(file: DataFile, element: number): string {
  return formatClassicAddress({ file: file.name, type: file.type, element, ...slotOf(file) });
}

function bitAddress(file: DataFile, element: number, bit: number): string {
  return formatClassicAddress({ file: file.name, type: file.type, element, bit, ...slotOf(file) });
}

export function DataFileView({
  project,
  index,
  name,
  selection,
  onSelect,
}: {
  project: ProjectModel;
  index: ProjectIndex;
  name: string;
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
}) {
  const file = project.dataFiles.find((f) => f.name === name);
  const [filter, setFilter] = useState("");
  const owner = project.programs[0]?.name ?? "";
  const where = useMemo(() => ({ kind: "program" as const, owner, routine: "" }), [owner]);
  const selectedKey = selection?.kind === "ref" ? index.resolve(selection.ref, selection.where).key : "";

  const rows = useMemo(() => {
    if (!file) return [];
    const q = filter.trim().toLowerCase();
    return file.elements
      .map((el, i) => {
        const addr = wordAddress(file, i);
        const info = index.resolve(addr, where);
        return { i, el, addr, info };
      })
      .filter(
        (r) => !q || r.addr.toLowerCase().includes(q) || r.info.description?.toLowerCase().includes(q),
      );
  }, [file, index, filter, where]);

  if (!file) return <div className="empty-state">Data file {name} not found.</div>;
  const struct = STRUCT_BITS[file.type];
  const bitFile = BIT_FILES.has(file.type);
  const octal = (file.type === "I" || file.type === "O") && !file.name.includes(":");

  const select = (ref: string) => onSelect({ kind: "ref", ref, where });

  return (
    <div className="view">
      <header className="view-head">
        <div className="eyebrow">Data file · values as saved in the export</div>
        <div className="view-title-row">
          <h1 className="view-title">{file.name}</h1>
          <span className="view-meta">{file.elements.length} elements</span>
        </div>
        <div className="toolbar">
          <input
            className="input"
            placeholder="Filter by address or description…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </header>
      <div className="table-wrap">
        <table className="table data-table">
          <thead>
            <tr>
              <th>Address</th>
              {struct ? (
                <>
                  <th>Status bits</th>
                  <th className="right">{file.type === "R" ? "LEN" : file.type === "BT" ? "RLEN" : "PRE"}</th>
                  <th className="right">{file.type === "R" ? "POS" : file.type === "BT" ? "DLEN" : "ACC"}</th>
                </>
              ) : bitFile ? (
                <th>
                  Bits {octal ? "17 … 0 (octal)" : "15 … 0"}
                </th>
              ) : (
                <th className="right">Value</th>
              )}
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ i, el, addr, info }) => {
              if (struct) {
                const words = Array.isArray(el) ? el : [];
                const ctl = words[0] ?? 0;
                return (
                  <tr key={i} className={`clickable ${selectedKey === addr ? "selected" : ""}`} onClick={() => select(addr)}>
                    <td className="mono nowrap">{addr}</td>
                    <td className="nowrap">
                      {struct.map(([b, bit]) => {
                        const on = ((ctl >>> bit) & 1) === 1;
                        return (
                          <button
                            key={b}
                            type="button"
                            className={`bitchip ${on ? "on" : ""}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              select(`${addr}/${b}`);
                            }}
                          >
                            {b}
                          </button>
                        );
                      })}
                    </td>
                    <td className="mono right">{words[1] ?? ""}</td>
                    <td className="mono right">{words[2] ?? ""}</td>
                    <td className="desc-cell">{info.description}</td>
                  </tr>
                );
              }
              const word = typeof el === "number" ? el : 0;
              if (bitFile) {
                const described = [] as string[];
                const bits = Array.from({ length: 16 }, (_, k) => 15 - k);
                return (
                  <tr key={i} className={selectedKey === addr ? "selected" : ""}>
                    <td className="mono nowrap">{addr}</td>
                    <td>
                      <div className="bitrow">
                        {bits.map((bit) => {
                          const baddr = bitAddress(file, i, bit);
                          const binfo = index.resolve(baddr, where);
                          if (binfo.description) described.push(`${baddr.split("/")[1]}: ${binfo.description}`);
                          const on = ((word >>> bit) & 1) === 1;
                          return (
                            <button
                              key={bit}
                              type="button"
                              className={`bitcell ${on ? "on" : ""} ${binfo.description ? "doc" : ""} ${selectedKey === binfo.key ? "sel" : ""} ${binfo.forced ? "forced" : ""}`}
                              title={`${baddr}${binfo.description ? ` — ${binfo.description}` : ""}`}
                              onClick={() => select(baddr)}
                            >
                              {on ? 1 : 0}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="desc-cell small">
                      {described.length ? `${described.length} documented bit${described.length === 1 ? "" : "s"}` : info.description}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={i} className={`clickable ${selectedKey === addr ? "selected" : ""}`} onClick={() => select(addr)}>
                  <td className="mono nowrap">{addr}</td>
                  <td className="mono right">
                    {typeof el === "number" ? (Number.isInteger(el) ? el : Number(el.toPrecision(7))) : typeof el === "string" ? `'${el}'` : ""}
                  </td>
                  <td className="desc-cell">{info.description}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
