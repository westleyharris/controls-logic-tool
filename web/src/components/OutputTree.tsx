import type { ExplainNode } from "../lib/explain";

/** Renders a rung's "When … → …" tree. */
export function OutputTree({ root, compact = false }: { root: ExplainNode; compact?: boolean }) {
  if (root.actions.length === 0 && root.children.length === 0) {
    return <p className="muted small">This rung has no outputs.</p>;
  }
  return (
    <ul className={`when-tree ${compact ? "compact" : ""}`}>
      {root.actions.length ? (
        <li>
          <span className="when">Always</span> {root.actions.join("; ")}
        </li>
      ) : null}
      {root.children.map((n, i) => (
        <Node key={i} node={n} />
      ))}
    </ul>
  );
}

function Node({ node }: { node: ExplainNode }) {
  return (
    <li>
      <span className="when">When</span> {node.when}
      {node.actions.length ? (
        <>
          {" "}
          <span className="then">→</span> {node.actions.join("; ")}
        </>
      ) : null}
      {node.children.length ? (
        <>
          {node.actions.length ? null : ":"}
          <ul>
            {node.children.map((c, i) => (
              <Node key={i} node={c} />
            ))}
          </ul>
        </>
      ) : null}
    </li>
  );
}
