# Controls Logic Tool

Drop in an Allen-Bradley export, understand the machine, and find out why something isn't happening.
Exports are parsed in the browser. Without signing in, everything stays on the device. Sign in to sync your
library (exports, drawings, notes) between your computer and phone through your own Supabase project.

## Run it

```bash
npm install
npm install --prefix web
npm run web
```

Open the printed URL. The start page is your **machine library**: pick a saved machine, or click **+ Add machine** and choose its export files.

| Platform | Files to pick | Status |
|---|---|---|
| PLC-5 | `.PC5` + `.SY6` (or `.SY5`) | Working |
| ControlLogix / CompactLogix | `.L5K` | Working |
| Logix XML | `.L5X` | Working. Checked against a hand-written fixture only, so send a real export to confirm |
| SLC 500 / MicroLogix | `.SLC` | Working. Includes rack/slot config, data tables and the S:37–S:42 save clock. Address descriptions aren't in the `.SLC` file |

Machines are organized **Company → Line → Machine**. Groups are collapsible, and each company or line can be renamed in one place. Machines without a company or line sit in a "No company" / "No line" group; use *Assign company* / *Assign line* there to file them all at once. The machines are stored in this browser's IndexedDB, with no limit on how many, and sync to your account when you sign in. Each one keeps its company, line, name, notes and export files. From the library you can rename a machine, replace its export with a newer one ("Update export"), or delete it. Switch between machines from the dropdown in the top bar. A reload brings you back to the machine and rung you were on.

## Phone, cloud sync and hosting

- **Sync between devices (☁ in the top bar).** Sign in with email and password, and the machines in this browser are copied to your account:
  - Export files are stored gzipped. A device downloads a machine's export the first time you open it there.
  - Drawings, alarm notes, spare-part notes and your message → machine links sync too.
  - Edits made offline are sent when you're back online. Your OpenAI key never leaves the device.
  - Row-level security limits every row and file to its owner. The schema is in [supabase/migrations](supabase/migrations).
- **Phone layout.** The organizer is a slide-in drawer, the inspector is a bottom sheet, and the top bar is compact. Add it to the home screen to run it like an app. Once hosted, the app shell is cached, so it opens on weak plant Wi-Fi.
- **Hosting on Vercel.** `vercel.json` builds `web/` and serves `web/dist`. Customer exports and drawings under `samples/` are git-ignored, so they're never deployed.

## Across the whole library (tabs on the start page)

- **Search all:** one search over every machine's alarms, tags, addresses, rung comments, modules and routines. A result opens that machine at the rung.
- **Network map:** who talks to whom, built from MSG instructions, Logix MESSAGE tags, sockets and produced/consumed tags.
  - Arrows show which way data goes.
  - Partners not in your library show as dashed boxes named from the message (e.g. "ASRS PLC", "Foreign Conveyor", "PowerMonitor"). Link one to a machine, or add its export, and the map connects it.
  - Machines are matched by IP, then by name, then by the links you set. PLC-5 exports don't record a MSG's target, so those partners are named from the data file's description.
- **Spare parts and obsolescence:** every catalog number from each I/O configuration, counted across machines.
  - Lifecycle is a rule of thumb you can override, with a link to confirm on Rockwell's site.
  - Includes an "on hand" count, notes, CSV export and print.

## Inside a machine

- **Start-up checklist:** pick what you're starting (main drive, conveyor…). The tool walks the logic back and lists every field device, fault, timer and setpoint that has to be right, with where each is wired and whether it was OK in the saved values. "Any one of these" groups mark alternatives. Tick items off, or print it.
- **Alarm handbook:** for every alarm bit, what raises it, the delay, how to reset it, which devices to check, and your own notes ("last time it was the infeed prox"). Printable.
- **Connections:** this machine's messages grouped by partner, with a jump to the rung and to the plant network map.
- **Drawings:** attach electrical drawings (PDF or photos) to a machine. PDF text is indexed, so the inspector shows which drawing pages mention an address. Ask AI can search the drawings and look at pages.
- **Ask AI with photos and voice:** add a photo of a panel or HMI screen, dictate the question, and have the answer read aloud.
- **Operator panel (PanelView Plus):** add the panel's FactoryTalk View ME runtime file (.MER) or project archive (.APA) to a machine, with or without its PLC export. You get:
  - Every screen drawn the way the panel shows it: colours, raised borders, outlines, pictures and fonts from the file, with each indicator in the state its saved PLC value selects. A plain sketch is one click away.
  - Per button or indicator, the PLC address it writes or shows, and which screen a goto button opens.
  - Alarm messages with their trigger word and the rung that moves each message number into it.
  - The inspector's "On the panel" list for any address. Search covers screens, buttons and messages. Ask AI gets a `search_panel` tool.
  - The files are read directly. No FactoryTalk View Studio export is needed.

## What you get today (Phases 1–4)

- **Organizer tree.** For Logix: Tasks → Programs → Routines, Add-On Instructions, Data Types and I/O. For PLC-5: Program Files and Data Files.
- **Ladder view.**
  - Branches stacked only as tall as their own content, outputs pushed to the right rail, and contacts/coils that were ON in the saved values highlighted green.
  - Rung comments, address descriptions above each contact, and real instruction blocks (TON/MOV/…).
  - AOI calls drawn with their parameter names.
  - JSR blocks that open the target routine.
  - A one-line plain-English summary under every rung.
- **Power flow from the saved values.**
  - Energized wires and branches are drawn in green.
  - Compare blocks that are true are highlighted, and AOI calls follow their EnableOut.
  - Each rung gets a true/false dot, and forced instructions get a red **F**.
  - It's a static evaluation of the snapshot: scan order and anything that changed after the file was saved aren't modelled.
- **Explain panel.** Click a rung to see:
  - What each output does and under which conditions.
  - Whether each output gets power, and if not, exactly which conditions are blocking it, including "one of these branches" groups.
  - Plain-English help for every instruction.
- **AOI logic through an instance.** Click an AOI block's *Logic →* (or pick an instance from the AOI page) to see the AOI's rungs with that instance's values and InOut arguments. The view flags instances whose EnableIn was OFF.
- **Ask AI (OpenAI, your key).** Add the key under ⚙ Settings, and pick a model after it's checked. You can then ask about a rung, a whole routine, an AOI or a single tag, with follow-up questions. The key stays in this browser, and a request is sent only when you click.
- **Structured Text** routines with syntax highlighting.
- **Ask AI about the machine (✦ Ask AI in the top bar).** Describe the problem in your own words, e.g. "the seamer brake is on, why won't it turn off?", with no program open. The assistant (OpenAI, your key) works through the program with tools that run locally:
  - It searches signals and traces why each is ON or OFF.
  - It reads rungs, alarms and health findings as needed.
  - It answers with a "why" chain and what to check on the machine, with clickable links to the rungs and tags.
  - Only what it looks up is sent to OpenAI. Without a key, the page lists the matching signals for you to trace.
- **Troubleshoot: why is it ON / OFF?** Pick any output, tag or address, or start from the list of physical outputs with their saved state. For that signal you get:
  - Every rung that writes it, whether that rung has power, and the condition blocking it.
  - **Why? ▸** on any blocking condition to follow it back through as many rungs as you like.
  - Timers explained with ACC/PRE, latches with their unlatch conditions, and physical inputs with their rack/group/terminal or module.
- **Health checks** across the whole program:
  - Forces, and PLC-5 major/minor fault bits in RSLogix's own wording.
  - Duplicate OTEs, OTE mixed with OTL/OTU, and latches with no unlatch.
  - Timers that were running at save time.
  - JSRs to missing routines, AFI-disabled rungs, and routines/AOIs nothing calls.
  - Disabled programs and tasks, and inhibited modules.
  - Tags read but never written (and the reverse), and source-protected logic.
- **Dashboard.** The Overview shows alarm/fault bits that were ON at save time, items needing attention, the scan structure and an I/O summary. Each has its own page: **Alarms & faults**, **I/O map** (PLC-5 by rack and group, Logix by module or I/O image) and **Scan structure** (task → program → JSR call tree).
- **Snapshot time.** For PLC-5, the processor clock at save time (S:18–S:23) is shown, so you know how old the values are.
- **Inspector.** Click any instruction to see the tag's description, data type, alias target and saved value, plus everything that writes and reads it. Each entry jumps to its rung.
- **Saved values.** Both export types store data values as of the save: PC5 `DATA`/`FORCE` tables and L5K tag values, decoded through their UDT and AOI layouts. They appear in the inspector, in the tag tables and in the PLC-5 data-table view. These are a snapshot from the file, not live readings.
- **⌘K search** across tags, addresses, descriptions, routines and rung comments.
- **Ladder display toggles:** descriptions on/off, saved-value highlighting, PLC-5 symbols instead of addresses, and compact spacing. Plus a go-to-rung box and a toolbar that stays pinned.
- **Resizable side panes**, remembered open tree folders, back/forward buttons, and a light/dark theme.

[ROADMAP.md](ROADMAP.md) has the phase history and what's next.

## Layout

```
src/            Shared importer core (pure TypeScript, runs in a Web Worker and in Node)
  importers/    pc5, sy6, l5k (+ l5kValues: tag value decoding), importFiles()
  ladder/       Rung text → ladder AST (classic BST/NXB/BND and Logix neutral text)
  importers/hmi FactoryTalk View ME .MER / .APA: compound-file reader, stream decoder, screens / alarms / shortcuts
  logic/        Instruction catalog, power flow, trace, health, overview, connectivity (messages),
                parts (hardware + lifecycle), checklist (start-up checklist / alarm handbook),
                hmi (panel ↔ PLC links, rungs that raise each alarm message)
  xref/         Scope-aware cross reference (read vs write per operand)
  query/        ProjectIndex: resolve any address/tag → description, type, saved value, hits
  cli/          Test harness
web/            React + Vite app (imports the core via the @core alias)
  src/lib/      sync.ts / cloud.ts (Supabase), kv.ts (synced notes), network.ts (map), pdf.ts (drawings)
supabase/       Database schema (tables, row-level security, storage bucket)
samples/        Hand-made fixtures (real customer exports are kept locally and git-ignored)
```

## Command-line test harness

```bash
npm run import -- samples/fixtures/mini_plc5               # prints stats and warnings
npm run import -- samples/<your export folder> --out out/machine.json
npm run typecheck
```
