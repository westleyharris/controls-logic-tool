/**
 * Canonical project model shared by all importers (PC5, L5K, L5X, SLC …).
 * Pure data: safe to structured-clone between a Web Worker and the UI.
 */

import type { LadderNode } from "../ladder/ast.js";

export type { LadderNode } from "../ladder/ast.js";

export type PlatformFamily = "plc5" | "slc" | "logix" | "unknown";

export type SourceFormat =
  | "pc5"
  | "sy5"
  | "sy6"
  | "l5k"
  | "l5x"
  | "slc"
  | "csv"
  | "mer"
  | "apa"
  | "unknown";

/** A file handed to the importer (from drag-and-drop or the CLI). */
export interface InputFile {
  name: string;
  /** Text exports (everything except HMI files). Empty for binary files. */
  text: string;
  /** Binary files (FactoryTalk View .MER / .APA). */
  bytes?: Uint8Array;
}

export interface SourceFile {
  name: string;
  format: SourceFormat;
  role: "logic" | "symbols" | "hmi" | "other";
  size: number;
}

export interface ControllerInfo {
  name: string;
  family: PlatformFamily;
  processorType?: string;
  series?: string;
  revision?: string;
  description?: string;
  majorRevision?: number;
  serialNumber?: string;
  raw?: Record<string, string>;
}

/** A value as it was saved in the export (not live). */
export type SavedValue =
  | number
  | boolean
  | string
  | SavedValue[]
  | { [member: string]: SavedValue };

/** PLC-5 / SLC symbol + description database row (.SY6, .SY5, .CSV). */
export interface SymbolRecord {
  address: string;
  symbol?: string;
  description?: string;
}

/** Logix tag (controller-, program- or AOI-scoped). */
export interface TagRecord {
  name: string;
  /** "" = controller scope; otherwise the program or AOI name. */
  scope: string;
  dataType: string;
  dims?: number[];
  description?: string;
  /** Alias target, e.g. `O31[0].0` or `Local:1:I.Data.3`. */
  aliasFor?: string;
  /** Per-member comments, e.g. COMMENT.DRIVESTATUS. Keys are upper-case member paths. */
  memberDescriptions?: Record<string, string>;
  value?: SavedValue;
  /** AOI parameter usage: Input / Output / InOut. */
  usage?: string;
  required?: boolean;
  visible?: boolean;
  /**
   * Communication settings kept from the export: MESSAGE configuration
   * (MessageType, ConnectionPath, RemoteElement, …), produced tags
   * (ProduceCount) and consumed tags (Producer, RemoteTag).
   */
  comm?: Record<string, string>;
}

export interface DataTypeMember {
  name: string;
  dataType: string;
  dims?: number;
  description?: string;
  hidden?: boolean;
  /** For BIT members: the hidden SINT host member and the bit number. */
  bitOf?: { host: string; bit: number };
}

export interface DataTypeDef {
  name: string;
  description?: string;
  family?: string;
  members: DataTypeMember[];
}

export interface Rung {
  /** Rung number as shown in RSLogix (0-based). */
  index: number;
  /** Original rung text (classic mnemonic or Logix neutral). */
  text: string;
  title?: string;
  comment?: string;
  ladder?: LadderNode;
}

export type RoutineType = "ladder" | "st" | "fbd" | "sfc" | "unknown";

export interface Routine {
  name: string;
  /** PLC-5/SLC program file number. */
  number?: number;
  type: RoutineType;
  description?: string;
  rungs: Rung[];
  /** Structured Text source lines. */
  stLines?: string[];
  /** Routine content is source-protected / encoded and can't be shown. */
  encoded?: boolean;
}

export interface Program {
  name: string;
  /** PLC-5/SLC program file number. */
  number?: number;
  description?: string;
  mainRoutine?: string;
  faultRoutine?: string;
  disabled?: boolean;
  routines: Routine[];
}

export interface ModuleNode {
  name: string;
  catalogNumber?: string;
  description?: string;
  parent?: string;
  slot?: string;
  address?: string;
  revision?: string;
  inhibited?: boolean;
  children: ModuleNode[];
  raw?: Record<string, string>;
}

export interface TaskInfo {
  name: string;
  description?: string;
  type?: string;
  rate?: string;
  priority?: string;
  watchdog?: string;
  inhibited?: boolean;
  programs: string[];
}

export interface AoiDefinition {
  name: string;
  description?: string;
  revision?: string;
  vendor?: string;
  helpText?: string;
  encoded?: boolean;
  parameters: TagRecord[];
  localTags: TagRecord[];
  routines: Routine[];
}

/** PLC-5 / SLC data table file with values as saved. */
export interface DataFile {
  /** e.g. "N7", "T4", "B3", "O", "I", "S". */
  name: string;
  type: string;
  number?: number;
  /** Words (B/N/I/O/S/F…), structures [CTL, PRE, ACC] (T/C/R/BT…) or strings (ST). */
  elements: (number | number[] | string)[];
  /** Element index labels for structure files, e.g. [".CTL", ".PRE", ".ACC"]. */
  fields?: string[];
}

export interface ForceEntry {
  address: string;
  state: "on" | "off";
}

/** Where a rung lives: a program routine or an AOI's internal routine. */
export interface RoutineRef {
  kind: "program" | "aoi";
  owner: string;
  routine: string;
}

export interface CrossReferenceHit extends RoutineRef {
  /** Address exactly as used in the instruction operand. */
  address: string;
  mnemonic: string;
  rung: number;
  access: "read" | "write";
}

export interface CrossReferenceEntry {
  /** Canonical address / scoped tag path, e.g. `T4:13/DN`, `Motor.Run`, `Program:HMI.Btn`. */
  key: string;
  /** Base tag or data-table element the key belongs to, e.g. `T4:13`, `Motor`. */
  base: string;
  hits: CrossReferenceHit[];
}

export interface ProjectModel {
  schemaVersion: 2;
  name: string;
  platform: PlatformFamily;
  controller: ControllerInfo;
  sources: SourceFile[];
  programs: Program[];
  tasks: TaskInfo[];
  modules: ModuleNode[];
  aois: AoiDefinition[];
  dataTypes: DataTypeDef[];
  /** Logix tags (controller + program scope). */
  tags: TagRecord[];
  /** PLC-5 / SLC symbol database. */
  symbols: SymbolRecord[];
  /** PLC-5 / SLC data tables (saved values). */
  dataFiles: DataFile[];
  forces: ForceEntry[];
  crossReference: CrossReferenceEntry[];
  /** Operator panels (FactoryTalk View ME .MER / .APA) that belong to this machine. */
  hmi?: HmiProject[];
  warnings: string[];
  stats: {
    programCount: number;
    routineCount: number;
    rungCount: number;
    tagCount: number;
    symbolCount: number;
    moduleCount: number;
    aoiCount: number;
    dataTypeCount: number;
    dataFileCount: number;
    forceCount: number;
    xrefCount: number;
  };
}

/* ------------------------------ operator panels ------------------------------ */

/** A PLC address on an HMI, e.g. `[PLC]N7:0/3` → { shortcut: "PLC", address: "N7:0/3" }. HMI tags have no shortcut. */
export interface HmiAddress {
  shortcut?: string;
  address: string;
}

/** write: the panel sets it (button value). read: it's shown (indicator, display). animation: visibility / colour. */
export type HmiAccess = "write" | "read" | "readwrite" | "animation";

export interface HmiConnection {
  /** Expression exactly as configured, e.g. `::[PLC]N22:1/4`. */
  expr: string;
  access: HmiAccess;
  refs: HmiAddress[];
}

export type HmiObjectKind = "button" | "input" | "indicator" | "display" | "text" | "shape" | "group" | "alarm" | "other";

/** One state of a button or indicator: caption and colours (#rrggbb). */
export interface HmiState {
  /** Tag value that selects this state (multistate indicators); index order otherwise. */
  value?: number;
  caption: string;
  fill?: string;
  /** Raised 3D border: base colour with its highlight and shadow. */
  border?: string;
  highlight?: string;
  shadow?: string;
}

export interface HmiObject {
  /** Object name in FactoryTalk View, e.g. MomentaryPushButton17. */
  name: string;
  /** Object type (the name without its number). */
  type: string;
  kind: HmiObjectKind;
  /** left, top, right, bottom in screen pixels. */
  rect?: [number, number, number, number];
  /** Captions / state texts, in order. */
  captions: string[];
  connections: HmiConnection[];
  /** Display a goto button opens. */
  goto?: string;
  /** Per-state captions and colours (buttons, indicators), in state order. */
  states?: HmiState[];
  /** Colours of single-look objects (panels, displays, shapes). */
  fill?: string;
  border?: string;
  highlight?: string;
  shadow?: string;
  /** Text objects: colour, background and font. */
  text?: { color?: string; back?: string; size?: number; bold?: boolean; font?: string };
  /** Polygons and lines: corner points in screen pixels. */
  points?: [number, number][];
  closed?: boolean;
  lineWidth?: number;
  /** Image objects: key into HmiProject.images. */
  image?: string;
}

export interface HmiScreen {
  name: string;
  width: number;
  height: number;
  /** Screen background (#rrggbb). */
  background?: string;
  objects: HmiObject[];
}

export interface HmiAlarmTrigger {
  index: number;
  label: string;
  expr: string;
  refs: HmiAddress[];
}

/** One alarm message: shown when the trigger tag equals `value`. */
export interface HmiAlarmMessage {
  value: number;
  /** Trigger index (1-based); 0 = not attached to a trigger. */
  trigger: number;
  text: string;
}

export interface HmiShortcut {
  name: string;
  /** RSLinx Enterprise path, e.g. Ethernet.MyPLC */
  device?: string;
  /** IP address from the RSLinx topology, when present. */
  address?: string;
  deviceType?: string;
}

export interface HmiProject {
  file: string;
  format: "mer" | "apa";
  application: string;
  /** Display the panel opens on. */
  startup?: string;
  screens: HmiScreen[];
  triggers: HmiAlarmTrigger[];
  messages: HmiAlarmMessage[];
  shortcuts: HmiShortcut[];
  /** Pictures used on the screens: name → base64 data. */
  images?: Record<string, { mime: string; data: string }>;
  warnings: string[];
}
