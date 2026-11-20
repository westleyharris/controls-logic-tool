# Controls Logic Tool — Overhaul Roadmap

**Purpose:** Drop in an Allen-Bradley export → understand the machine → find out why something isn't happening.

## Decisions (2026-11-17)

| Topic | Decision |
|---|---|
| Where it runs | Browser app, hosted on Vercel. Exports are parsed in the browser. Optional sign-in syncs the library through Supabase (2026-11-19). |
| Explanations | Built-in rule-based explanations always work offline. An optional **Ask AI** button calls OpenAI with your own API key, which is stored only in the browser. It sends just the selected rung or routine, and only when you click. |
| Formats | All of them: PLC-5 (`.PC5` + `.SY6`/`.SY5`), Logix `.L5K`, Logix `.L5X`, SLC 500 / MicroLogix (`.SLC` export + symbol CSV) |
| Look | RSLogix-style ladder layout with a light/dark toggle |

## App layout

```
┌──────────────┬──────────────────────────────────────┬─────────────────┐
│ Organizer    │ Ladder (RSLogix-style)               │ Inspector       │
│ ─ Overview   │  rung #, comment                     │ ─ Explain rung  │
│ ─ Tasks      │  ┤ ├──┤/├──┬──( )                    │ ─ Instruction   │
│   └ Programs │  tag desc  └─[TON T4:9 PRE/ACC]      │ ─ Tag: value,   │
│     └ Rtns   │  green = true in saved values        │   writers/readers│
│ ─ AOIs/UDTs  │                                      │ ─ Why is it off?│
│ ─ I/O        │                                      │ ─ Ask AI        │
│ ─ Health     │                                      │                 │
└──────────────┴──────────────────────────────────────┴─────────────────┘
  ⌘K search anywhere: tag, address, description, rung comment → jump
```

## Phase 1: Foundation (make it the tool it's meant to be) ✅ done 2026-11-17

Two more parser bugs turned up and were fixed along the way:
- PLC-5 rung comments were attached to the rung *after* the one they describe.
- Section headers were detected by their first word, so comment lines starting with "START…" cut 122 rungs off program files.

- Move the parsers into a shared `core/` that runs in the browser. Today `pc5.ts`, `l5k.ts`, `sy6.ts` and `detect.ts` read files with Node `fs`; they should take file text instead.
- Drop zone that accepts multiple files and detects the format. Parsing runs in a Web Worker because the L5K is 5 MB. Recent projects are kept in IndexedDB.
- Fix the PLC-5 parser so `BST`/`NXB`/`BND` stop being counted as instructions. Today they add 431 bogus `NXB` entries to the xref and stats.
- Capture saved values:
  - PC5: `DATA` tables (bits, timer/counter CTL/PRE/ACC, integers, floats) and `FORCE` tables
  - L5K: the `:= [...]` value on each tag, decoded against its UDT/AOI layout
- New shell: organizer tree, ladder, inspector, ⌘K search, light/dark toggle.
- Delete the disconnected views (`Overview`, `TraceView`, `TagsView`, `IoMapView`, `ConnectivityView`) and the hardcoded sample catalog, plus the CLI → JSON → `sync:web-data` workflow. The CLI stays only as a test harness.

## Phase 2: RSLogix-style ladder and Explain ✅ done 2026-11-18

There's no real OpenAI test yet, because that needs your key. The request and response handling was tested with a stubbed network call.

- Draw real instruction blocks: TON/TOF/RTO, CTU/CTD, MOV/COP/FLL, compares, math, CPT/CMP expressions, JSR, MSG, GSV/SSV, BTR/BTW, and so on.
- AOI calls drawn as blocks labeled with their parameter names, taken from the AOI definitions in the file. You can step into the AOI's logic, and into JSR targets.
- Structured Text routines shown as formatted text.
- Saved-value overlay: true contacts highlighted, power flow through the rung, timer/counter values, active forces flagged. It's labeled "values as saved in file" so nobody mistakes it for live data.
- Explain panel:
  - What the rung does, in plain English
  - What each instruction does
  - What the rung comment means
  - Where each tag comes from and goes
- **Ask AI**, using OpenAI and the key you enter in settings. It works on a rung, a routine or an AOI, and includes the tag descriptions as context.

## Phase 3: Troubleshoot ✅ done 2026-11-18

- **Why is X off (or on)?** Pick an output or tag. The tool finds every rung that writes it, evaluates those rungs against the saved values, highlights the blocking condition, and lets you follow it upstream as a tree.
- Health checks:
  - Duplicate OTE
  - OTL with no OTU
  - Active forces
  - Tags written but never read, and read but never written
  - Unused routines
  - Timers stuck timing
  - Major and minor fault info in the status file
- Tag inspector: value, description, every place it's written and read, and the I/O point behind it.

## Phase 4: Overview and remaining formats — dashboard ✅, L5X ✅ (checked only against a hand-written fixture), SLC ✅ (from a real SLC 5/05 export, 2026-11-18)

- Overview dashboard:
  - Controller info and scan structure (task → program → JSR call graph)
  - I/O map by rack and slot with descriptions
  - Alarm list (Logix alarm AOI instances, PLC-5 message texts)
  - Health summary
- `.L5X` importer.
- SLC 500 / MicroLogix importer (`.SLC` text export + symbol `.CSV`/`.EAS`). **This needs sample exports.**

## Phase 5: On the floor ✅ done 2026-11-19

- Phone layout (drawer organizer, bottom-sheet inspector), installable with an offline shell.
- Cloud library on Supabase: email/password sign-in, machines + gzipped exports + drawings + notes, offline edits queued.
- Electrical drawings per machine (PDF text indexed, linked from the inspector, searchable and viewable by Ask AI).
- Ask AI with photos, dictation and read-aloud.
- Start-up checklist and alarm handbook (printable).
- Library-wide search, machine network map (messages / produced-consumed, unknown partners named from the message), spare parts and obsolescence report.

## Phase 6: Operator panels ✅ done 2026-11-19

- FactoryTalk View ME .MER and .APA read directly in the browser. Both are compound files of LZSS-packed chunks; the format was worked out from a real PanelView Plus application and checked against both files of it.
- Screens are sketched from object positions and captions. Each object's PLC connections are typed as write, read, entry or animation, with goto targets and the startup display.
- Alarm setup: trigger word plus numbered messages. The rung that MOVs each number into the trigger word was found in tests on PLC-5, SLC and Logix samples, using a synthetic trigger, because no real panel + PLC pair was available.
- The PLC shortcut is resolved to its IP through the RSLinx Enterprise topology.
- Panel-only machines are allowed (add the PLC export later). Panel and PLC files update independently.
- Panel look (2026-11-20): colours, raised borders, polygon outlines (with each object's transform), pictures and text fonts are read from the file, and indicators show the state their saved value selects.
- Known gaps:
  - Button and indicator text colours are picked for contrast. Their field in the file isn't pinned down yet: a photo of a real screen would settle it.
  - Animations (visibility, colour) aren't applied, and PanelView bitmap fonts are drawn as Arial.
  - Bit-type alarm triggers are treated like value triggers.
  - HMI tags (not direct references) are listed by name only.
  - Only one application per format has been seen (FactoryTalk View ME 5.x/6.x era).

## Next

- Panels: link the PLC shortcut's IP to library machines on the network map; read HMI tag databases; draw images.

- RSLogix 500 description CSV for SLC exports (waiting on a sample export).
- Check the L5X importer against a real export.
- Line-level alarm handbook (all machines on a line in one printout).
