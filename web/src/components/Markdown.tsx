import type { ReactNode } from "react";

/** Called for in-app links like rung:MAIN/MAIN/7 or tag:O:002/11@MAIN. */
type LinkHandler = (href: string) => void;

/** Minimal, safe Markdown for AI answers: headings, lists, bold, inline code, links, paragraphs. */
function inline(text: string, key: string, onLink?: LinkHandler): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if ((m.index ?? 0) > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const [, label, href] = link;
      if (onLink && /^(rung|tag):/.test(href!.trim())) {
        out.push(
          <button key={`${key}-${k++}`} type="button" className="md-link" onClick={() => onLink(href!.trim())}>
            {label}
          </button>,
        );
      } else if (/^https?:\/\//.test(href!)) {
        out.push(
          <a key={`${key}-${k++}`} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else out.push(label);
    } else if (tok.startsWith("**")) out.push(<strong key={`${key}-${k++}`}>{tok.slice(2, -2)}</strong>);
    else out.push(<code key={`${key}-${k++}`}>{tok.slice(1, -1)}</code>);
    last = (m.index ?? 0) + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, onLink }: { text: string; onLink?: LinkHandler }) {
  const lines = text.replace(/\r/g, "").split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(" "), `p${blocks.length}`, onLink)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}-${i}`, onLink)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^#{1,4}\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (h) {
      flushPara();
      flushList();
      blocks.push(<h4 key={blocks.length}>{inline(h[1]!.replace(/\*\*/g, ""), `h${blocks.length}`, onLink)}</h4>);
    } else if (ul || ol) {
      flushPara();
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((ul ?? ol)![1]!);
    } else if (list && /^\s{2,}/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <div className="md">{blocks}</div>;
}
