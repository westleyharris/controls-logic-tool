import type { SymbolRecord } from "../model/types.js";
import { canonicalClassic } from "../logic/refs.js";

/**
 * RSLogix 5 .SY5 / .SY6 fixed-width symbol export.
 * Header: ADDRESS…  SYMFIL SYMBOL…  DES 1… DES 5…  DEV.. ABV… BLW…
 */
export function parseSy6Text(text: string): SymbolRecord[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = lines[0] ?? "";
  const col = (name: string) => header.indexOf(name);
  const symfil = col("SYMFIL");
  const addressEnd = symfil > 0 ? symfil : 40;
  const symbolStart = col("SYMBOL");
  const desStarts = [1, 2, 3, 4, 5].map((n) => col(`DES ${n}`)).filter((x) => x >= 0);
  const devStart = col("DEV");

  const records = new Map<string, SymbolRecord>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const addressRaw = line.slice(0, addressEnd).trim();
    if (!addressRaw || addressRaw === "ADDRESS") continue;

    const symbolEnd = desStarts[0] ?? addressEnd + 20;
    const symbol = symbolStart >= 0 ? line.slice(symbolStart, symbolEnd).trim() : "";
    const parts: string[] = [];
    desStarts.forEach((start, d) => {
      const end = desStarts[d + 1] ?? (devStart > start ? devStart : line.length);
      const part = line.slice(start, end).trim();
      if (part) parts.push(part);
    });
    const description = parts.join(" ").replace(/\s+/g, " ").trim();
    if (!symbol && !description) continue;

    const address = canonicalClassic(addressRaw);
    const rec: SymbolRecord = { address };
    if (symbol) rec.symbol = symbol;
    if (description) rec.description = description;
    records.set(address, rec);
  }
  return [...records.values()];
}
