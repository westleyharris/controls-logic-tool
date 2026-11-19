/** Ladder AST for visual rendering and analysis. */

export interface LadderInstruction {
  kind: "instruction";
  mnemonic: string;
  operands: string[];
}

export type LadderNode =
  | LadderInstruction
  | { kind: "series"; elements: LadderNode[] }
  | { kind: "parallel"; branches: LadderNode[] };

export interface LadderGraph {
  root: LadderNode;
}
