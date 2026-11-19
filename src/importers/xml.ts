/**
 * Small, dependency-free XML reader for L5X. (DOMParser isn't available in
 * Web Workers or Node.) Handles elements, attributes, text, CDATA, comments,
 * processing instructions and the standard entities.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text and CDATA directly inside this element. */
  text: string;
}

function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[e] ?? "";
  });
}

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const lt = src.indexOf("<", i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) {
      const t = src.slice(i, lt);
      if (t.trim()) top.text += decodeEntities(t);
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      top.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") {
      const end = src.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src[lt + 1] === "/") {
      const end = src.indexOf(">", lt);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Start tag: read name and attributes, honoring quoted values.
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j]!)) j += 1;
    const node: XmlNode = { name: src.slice(lt + 1, j), attrs: {}, children: [], text: "" };
    let selfClosing = false;
    while (j < n) {
      while (j < n && /\s/.test(src[j]!)) j += 1;
      const ch = src[j];
      if (ch === ">") {
        j += 1;
        break;
      }
      if (ch === "/" && src[j + 1] === ">") {
        selfClosing = true;
        j += 2;
        break;
      }
      const eq = src.indexOf("=", j);
      if (eq < 0) {
        j = n;
        break;
      }
      const key = src.slice(j, eq).trim();
      let k = eq + 1;
      while (k < n && /\s/.test(src[k]!)) k += 1;
      const quote = src[k];
      if (quote !== '"' && quote !== "'") {
        j = k + 1;
        continue;
      }
      const close = src.indexOf(quote, k + 1);
      node.attrs[key] = decodeEntities(src.slice(k + 1, close < 0 ? n : close));
      j = close < 0 ? n : close + 1;
    }
    top.children.push(node);
    if (!selfClosing) stack.push(node);
    i = j;
  }
  return root;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function childrenOf(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

/** Text of a <Description>-style element (plain CDATA or the first LocalizedDescription). */
export function descriptionOf(node: XmlNode | undefined, name = "Description"): string | undefined {
  const d = child(node, name);
  if (!d) return undefined;
  const text = (d.text || child(d, "LocalizedDescription")?.text || "").trim();
  return text || undefined;
}
