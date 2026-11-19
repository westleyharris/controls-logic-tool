import type { LadderNode } from "@core/model/types";
import type { ProjectIndex, Scope } from "@core/query/index";
import { evaluateInScope } from "@core/logic/trace";
import type { RungEvaluation } from "@core/logic/evaluate";

export { scopeKey } from "@core/logic/trace";

/** Power flow for one rung against the saved values (cached per rung and scope). */
export function evaluate(root: LadderNode, index: ProjectIndex, where: Scope): RungEvaluation {
  return evaluateInScope(root, index, where);
}
