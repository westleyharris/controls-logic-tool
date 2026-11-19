/**
 * Instruction catalog: operand roles for cross-reference (read vs write),
 * operand names for display, and categories. Shared by PLC-5, SLC and Logix.
 */

export type InstructionCategory =
  | "bit"
  | "timer"
  | "counter"
  | "compare"
  | "math"
  | "move"
  | "logical"
  | "file"
  | "shift"
  | "sequencer"
  | "program"
  | "io"
  | "special"
  | "aoi"
  | "unknown";

export interface InstructionInfo {
  name: string;
  category: InstructionCategory;
  /** Operand indices that the instruction writes. */
  write?: number[];
  /** Operand indices that contain expressions (multiple tags). */
  expr?: number[];
  /** Display names for operands, in order. */
  operands?: string[];
  /** Instruction is an output (sits on the right side of a rung). */
  output?: boolean;
}

const I = (
  name: string,
  category: InstructionCategory,
  operands: string[] = [],
  write: number[] = [],
  extra: Partial<InstructionInfo> = {},
): InstructionInfo => ({ name, category, operands, write, ...extra });

const LIST: InstructionInfo[] = [
  // Bit
  I("XIC", "bit", ["Bit"]),
  I("XIO", "bit", ["Bit"]),
  I("OTE", "bit", ["Bit"], [0], { output: true }),
  I("OTL", "bit", ["Bit"], [0], { output: true }),
  I("OTU", "bit", ["Bit"], [0], { output: true }),
  I("ONS", "bit", ["Storage Bit"], [0]),
  I("OSR", "bit", ["Storage Bit", "Output Bit"], [0, 1]),
  I("OSF", "bit", ["Storage Bit", "Output Bit"], [0, 1]),
  I("IIN", "io", ["Input Word"], [], {}),
  // Timers / counters
  I("TON", "timer", ["Timer", "Time Base", "Preset", "Accum"], [0], { output: true }),
  I("TOF", "timer", ["Timer", "Time Base", "Preset", "Accum"], [0], { output: true }),
  I("RTO", "timer", ["Timer", "Time Base", "Preset", "Accum"], [0], { output: true }),
  I("TONR", "timer", ["Timer"], [0], { output: true }),
  I("TOFR", "timer", ["Timer"], [0], { output: true }),
  I("RTOR", "timer", ["Timer"], [0], { output: true }),
  I("CTU", "counter", ["Counter", "Preset", "Accum"], [0], { output: true }),
  I("CTD", "counter", ["Counter", "Preset", "Accum"], [0], { output: true }),
  I("CTUD", "counter", ["Counter"], [0], { output: true }),
  I("RES", "timer", ["Structure"], [0], { output: true }),
  // Compare
  I("EQU", "compare", ["Source A", "Source B"]),
  I("NEQ", "compare", ["Source A", "Source B"]),
  I("LES", "compare", ["Source A", "Source B"]),
  I("LEQ", "compare", ["Source A", "Source B"]),
  I("GRT", "compare", ["Source A", "Source B"]),
  I("GEQ", "compare", ["Source A", "Source B"]),
  I("LIM", "compare", ["Low Limit", "Test", "High Limit"]),
  I("MEQ", "compare", ["Source", "Mask", "Compare"]),
  I("CMP", "compare", ["Expression"], [], { expr: [0] }),
  // Math
  I("ADD", "math", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("SUB", "math", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("MUL", "math", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("DIV", "math", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("MOD", "math", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("DDV", "math", ["Source", "Dest"], [1], { output: true }),
  I("NEG", "math", ["Source", "Dest"], [1], { output: true }),
  I("ABS", "math", ["Source", "Dest"], [1], { output: true }),
  I("SQR", "math", ["Source", "Dest"], [1], { output: true }),
  I("SQRT", "math", ["Source", "Dest"], [1], { output: true }),
  I("XPY", "math", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("CPT", "math", ["Dest", "Expression"], [0], { expr: [1], output: true }),
  I("SIN", "math", ["Source", "Dest"], [1], { output: true }),
  I("COS", "math", ["Source", "Dest"], [1], { output: true }),
  I("TAN", "math", ["Source", "Dest"], [1], { output: true }),
  I("ASN", "math", ["Source", "Dest"], [1], { output: true }),
  I("ACS", "math", ["Source", "Dest"], [1], { output: true }),
  I("ATN", "math", ["Source", "Dest"], [1], { output: true }),
  I("LN", "math", ["Source", "Dest"], [1], { output: true }),
  I("LOG", "math", ["Source", "Dest"], [1], { output: true }),
  I("SCL", "math", ["Source", "Rate", "Offset", "Dest"], [3], { output: true }),
  I("SCP", "math", ["Input", "Input Min", "Input Max", "Scaled Min", "Scaled Max", "Output"], [5], {
    output: true,
  }),
  // Move / logical
  I("MOV", "move", ["Source", "Dest"], [1], { output: true }),
  I("MVM", "move", ["Source", "Mask", "Dest"], [2], { output: true }),
  I("BTD", "move", ["Source", "Source Bit", "Dest", "Dest Bit", "Length"], [2], { output: true }),
  I("CLR", "move", ["Dest"], [0], { output: true }),
  I("SWPB", "move", ["Source", "Order Mode", "Dest"], [2], { output: true }),
  I("TOD", "move", ["Source", "Dest"], [1], { output: true }),
  I("FRD", "move", ["Source", "Dest"], [1], { output: true }),
  I("AND", "logical", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("OR", "logical", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("XOR", "logical", ["Source A", "Source B", "Dest"], [2], { output: true }),
  I("NOT", "logical", ["Source", "Dest"], [1], { output: true }),
  I("BAND", "logical", [], [], {}),
  // File / array
  I("COP", "file", ["Source", "Dest", "Length"], [1], { output: true }),
  I("CPS", "file", ["Source", "Dest", "Length"], [1], { output: true }),
  I("FLL", "file", ["Source", "Dest", "Length"], [1], { output: true }),
  I("FAL", "file", ["Control", "Length", "Position", "Mode", "Dest", "Expression"], [0, 4], {
    expr: [5],
    output: true,
  }),
  I("FSC", "file", ["Control", "Length", "Position", "Mode", "Expression"], [0], {
    expr: [4],
    output: true,
  }),
  I("AVE", "file", ["Array", "Dim to Vary", "Dest", "Control", "Length", "Position"], [2, 3], {
    output: true,
  }),
  I("SRT", "file", ["Array", "Dim to Vary", "Control", "Length", "Position"], [0, 2], { output: true }),
  I("SIZE", "file", ["Source", "Dim to Vary", "Size"], [2], { output: true }),
  // Shift / FIFO / LIFO
  I("BSL", "shift", ["Array", "Control", "Source Bit", "Length"], [0, 1], { output: true }),
  I("BSR", "shift", ["Array", "Control", "Source Bit", "Length"], [0, 1], { output: true }),
  I("FFL", "shift", ["Source", "FIFO", "Control", "Length", "Position"], [1, 2], { output: true }),
  I("FFU", "shift", ["FIFO", "Dest", "Control", "Length", "Position"], [1, 2], { output: true }),
  I("LFL", "shift", ["Source", "LIFO", "Control", "Length", "Position"], [1, 2], { output: true }),
  I("LFU", "shift", ["LIFO", "Dest", "Control", "Length", "Position"], [1, 2], { output: true }),
  // Sequencers
  I("SQI", "sequencer", ["Array", "Mask", "Source", "Control", "Length", "Position"], [3]),
  I("SQO", "sequencer", ["Array", "Mask", "Dest", "Control", "Length", "Position"], [2, 3], {
    output: true,
  }),
  I("SQL", "sequencer", ["Array", "Source", "Control", "Length", "Position"], [0, 2], { output: true }),
  // Program control
  I("JSR", "program", ["Routine"], [], { output: true }),
  I("SBR", "program", ["Input Par"], []),
  I("RET", "program", ["Return Par"], [], { output: true }),
  I("JMP", "program", ["Label"], [], { output: true }),
  I("LBL", "program", ["Label"], []),
  I("MCR", "program", [], [], { output: true }),
  I("TND", "program", [], [], { output: true }),
  I("AFI", "program", [], []),
  I("NOP", "program", [], [], { output: true }),
  I("UID", "program", [], [], { output: true }),
  I("UIE", "program", [], [], { output: true }),
  I("EOT", "program", [], [], { output: true }),
  I("SFR", "program", [], [], { output: true }),
  I("EVENT", "program", ["Task"], [], { output: true }),
  // I/O and comms
  I("MSG", "io", ["Message Control"], [0], { output: true }),
  I("BTR", "io", ["Rack", "Group", "Module", "Control Block", "Data File", "Length", "Continuous"], [3, 4], {
    output: true,
  }),
  I("BTW", "io", ["Rack", "Group", "Module", "Control Block", "Data File", "Length", "Continuous"], [3], {
    output: true,
  }),
  I("GSV", "io", ["Class Name", "Instance Name", "Attribute Name", "Dest"], [3], { output: true }),
  I("SSV", "io", ["Class Name", "Instance Name", "Attribute Name", "Source"], [], { output: true }),
  I("IOT", "io", ["Update Tag"], [], { output: true }),
  // Special
  I("PID", "special", ["PID", "Process Variable", "Tieback", "Control Variable"], [0, 3], { output: true }),
  I("DTR", "special", ["Source", "Mask", "Reference"], [2]),
  I("SDS", "special", [], [], { output: true }),
  I("DDT", "special", [], [0, 4], { output: true }),
  I("FBC", "special", [], [0, 4], { output: true }),
];

const CATALOG = new Map(LIST.map((i) => [i.name, i]));

export function instructionInfo(mnemonic: string): InstructionInfo | undefined {
  return CATALOG.get(mnemonic.toUpperCase());
}

/** Mnemonics that may appear in classic (PLC-5 / SLC) rung text. */
export const CLASSIC_MNEMONICS: ReadonlySet<string> = new Set([
  ...CATALOG.keys(),
  "SOR",
  "EOR",
  "BST",
  "NXB",
  "BND",
  "IDI",
  "IDO",
  "ACS",
  "ASC",
  "ASR",
  "ABL",
  "ACB",
  "ACI",
  "ACN",
  "AEX",
  "AHL",
  "AIC",
  "ARD",
  "ARL",
  "AWA",
  "AWT",
  "STD",
  "SVC",
  "REF",
  "INT",
  "STI",
  "DEG",
  "RAD",
  "SCL",
  "ENC",
  "DCD",
  "CIO",
  "ONS",
  "END",
]);

export const STRUCTURAL = new Set(["SOR", "EOR", "BST", "NXB", "BND"]);

/** Function names / operators that can appear inside CMP/CPT/FAL expressions. */
export const EXPRESSION_KEYWORDS = new Set([
  "AND",
  "OR",
  "XOR",
  "NOT",
  "MOD",
  "ABS",
  "SQR",
  "SQRT",
  "SIN",
  "COS",
  "TAN",
  "ASN",
  "ACS",
  "ATN",
  "ASIN",
  "ACOS",
  "ATAN",
  "LN",
  "LOG",
  "DEG",
  "RAD",
  "FRD",
  "TOD",
  "TRN",
  "TRUNC",
  "BCD",
  "INT",
]);

/** One-line, plain-English description of what each instruction does. */
const HELP: Record<string, string> = {
  XIC: "Examine If Closed — passes power when the bit is ON (1).",
  XIO: "Examine If Open — passes power when the bit is OFF (0).",
  OTE: "Output Energize — turns the bit ON while the rung is true and OFF when it's false.",
  OTL: "Output Latch — turns the bit ON when the rung is true; it stays ON until an OTU unlatches it.",
  OTU: "Output Unlatch — turns the bit OFF when the rung is true.",
  ONS: "One Shot — passes power for a single scan when the rung goes from false to true.",
  OSR: "One Shot Rising — sets the output bit for one scan when the rung goes true.",
  OSF: "One Shot Falling — sets the output bit for one scan when the rung goes false.",
  TON: "Timer On Delay — while the rung is true the accumulator counts up; DN turns ON when ACC reaches PRE. Resets when the rung goes false.",
  TOF: "Timer Off Delay — DN is ON while the rung is true; after the rung goes false it stays ON until ACC reaches PRE.",
  RTO: "Retentive Timer On — like TON but keeps its accumulated time when the rung goes false. Needs a RES to clear.",
  TONR: "Timer On Delay with Reset (function-block style timer).",
  CTU: "Count Up — adds 1 to ACC each time the rung goes true; DN turns ON when ACC ≥ PRE.",
  CTD: "Count Down — subtracts 1 from ACC each time the rung goes true.",
  CTUD: "Count Up/Down counter.",
  RES: "Reset — clears a timer's or counter's accumulator and status bits.",
  EQU: "Equal — passes power when Source A = Source B.",
  NEQ: "Not Equal — passes power when Source A ≠ Source B.",
  LES: "Less Than — passes power when Source A < Source B.",
  LEQ: "Less Than or Equal — passes power when Source A ≤ Source B.",
  GRT: "Greater Than — passes power when Source A > Source B.",
  GEQ: "Greater Than or Equal — passes power when Source A ≥ Source B.",
  LIM: "Limit Test — passes power when Test is between Low Limit and High Limit.",
  MEQ: "Masked Equal — compares only the bits selected by the mask.",
  CMP: "Compare — passes power when the expression is true.",
  ADD: "Add — Dest = Source A + Source B.",
  SUB: "Subtract — Dest = Source A − Source B.",
  MUL: "Multiply — Dest = Source A × Source B.",
  DIV: "Divide — Dest = Source A ÷ Source B.",
  MOD: "Modulo — Dest = remainder of Source A ÷ Source B.",
  NEG: "Negate — Dest = −Source.",
  ABS: "Absolute value — Dest = |Source|.",
  SQR: "Square root — Dest = √Source.",
  SQRT: "Square root — Dest = √Source.",
  CPT: "Compute — evaluates the expression and stores the result in Dest.",
  SCL: "Scale — Dest = Source × Rate / 10000 + Offset.",
  SCP: "Scale with Parameters — linearly scales Input from its range to the scaled range.",
  MOV: "Move — copies Source into Dest every scan the rung is true.",
  MVM: "Masked Move — copies only the bits of Source selected by Mask into Dest.",
  BTD: "Bit Field Distribute — copies a group of bits from Source into Dest.",
  CLR: "Clear — sets Dest to 0.",
  SWPB: "Swap Bytes — reorders the bytes of Source into Dest.",
  TOD: "To BCD — converts an integer to BCD.",
  FRD: "From BCD — converts a BCD value to an integer.",
  AND: "Bitwise AND — Dest = Source A AND Source B.",
  OR: "Bitwise OR — Dest = Source A OR Source B.",
  XOR: "Bitwise XOR — Dest = Source A XOR Source B.",
  NOT: "Bitwise NOT — Dest = inverted bits of Source.",
  COP: "Copy File — copies Length elements from Source to Dest.",
  CPS: "Synchronous Copy — copies Length elements without being interrupted by I/O updates.",
  FLL: "File Fill — fills Length elements of Dest with the Source value.",
  FAL: "File Arithmetic and Logic — runs an expression over a range of array elements.",
  FSC: "File Search and Compare — searches an array for an element that makes the expression true.",
  AVE: "Average — averages array elements.",
  SRT: "Sort — sorts array elements.",
  SIZE: "Size In Elements — returns the number of elements in an array dimension.",
  BSL: "Bit Shift Left — shifts the bit array one position left each time the rung goes true, loading Source Bit.",
  BSR: "Bit Shift Right — shifts the bit array one position right each time the rung goes true.",
  FFL: "FIFO Load — adds Source to the end of the FIFO queue.",
  FFU: "FIFO Unload — removes the oldest value from the FIFO queue into Dest.",
  LFL: "LIFO Load — pushes Source onto the LIFO stack.",
  LFU: "LIFO Unload — pops the newest value off the LIFO stack into Dest.",
  SQI: "Sequencer Input — compares input data to the current sequencer step.",
  SQO: "Sequencer Output — steps through an array and writes each step to Dest.",
  SQL: "Sequencer Load — stores Source into the sequencer array.",
  JSR: "Jump to Subroutine — runs another routine (program file), then comes back here.",
  SBR: "Subroutine — marks the start of a subroutine and receives its input parameters.",
  RET: "Return — ends the subroutine and returns to the JSR that called it.",
  JMP: "Jump — skips ahead to the matching LBL when the rung is true.",
  LBL: "Label — target of a JMP.",
  MCR: "Master Control Reset — when false, de-energizes non-retentive outputs in the zone.",
  TND: "Temporary End — ends the scan of this routine here when the rung is true.",
  AFI: "Always False — forces the rung false (often used to disable a rung).",
  NOP: "No Operation — does nothing (placeholder).",
  UID: "User Interrupt Disable.",
  UIE: "User Interrupt Enable.",
  MSG: "Message — sends or reads data over the network/backplane; watch .EN, .DN and .ER.",
  BTR: "Block Transfer Read — reads a block of data from an intelligent I/O module.",
  BTW: "Block Transfer Write — writes a block of data to an intelligent I/O module.",
  GSV: "Get System Value — reads controller/module status information into Dest.",
  SSV: "Set System Value — writes a controller/module attribute.",
  IIN: "Immediate Input — updates an input word right now instead of waiting for the I/O scan.",
  IOT: "Immediate Output — sends output data right now instead of waiting for the I/O scan.",
  PID: "PID loop — calculates Control Variable from the Process Variable and setpoint.",
  EVENT: "Trigger an event task.",
};

export function instructionHelp(mnemonic: string): string | undefined {
  return HELP[mnemonic.toUpperCase()];
}
