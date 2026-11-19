/**
 * PDF drawings: text extraction (for search and the AI) and page rendering,
 * using pdf.js. Scanned drawings have no text layer — those pages still render,
 * and the AI can look at them as images.
 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

const docs = new Map<string, Promise<PdfDoc>>();

function open(key: string, blob: Blob): Promise<PdfDoc> {
  let doc = docs.get(key);
  if (!doc) {
    doc = blob.arrayBuffer().then((buf) => pdfjs.getDocument({ data: new Uint8Array(buf) }).promise);
    docs.set(key, doc);
  }
  return doc;
}

export async function extractPdfText(blob: Blob, onProgress?: (page: number, total: number) => void): Promise<string[]> {
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => ("str" in it ? it.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(text);
    onProgress?.(i, doc.numPages);
  }
  await task.destroy();
  return pages;
}

/** Render one page to a canvas-backed data URL (JPEG for the AI, PNG-quality for viewing). */
export async function renderPdfPage(key: string, blob: Blob, pageNumber: number, targetWidth: number, mime = "image/png"): Promise<string> {
  const doc = await open(key, blob);
  const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: targetWidth / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return canvas.toDataURL(mime, 0.85);
}

/** Downscale an image file to a JPEG data URL (photos for the AI). */
export async function imageToDataUrl(blob: Blob, maxSide = 1600): Promise<string> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Couldn't read that image"));
      el.src = url;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ---------------------------- finding text in drawings ---------------------------- */

export interface DrawingHit {
  attachmentId: string;
  name: string;
  page: number;
  snippet: string;
}

/** Ways an address may be printed on a drawing (I:004/11 → I:4/11, I:004/11, 004/11…). */
export function addressVariants(ref: string): string[] {
  const t = ref.trim().toUpperCase();
  const out = new Set([t]);
  const io = t.match(/^([IO]):0*(\d+)(?:\.(\d+))?(?:\/(\d+))?$/);
  if (io) {
    const [, d, w, sub, bit] = io;
    const words = [w!, w!.padStart(3, "0"), w!.padStart(2, "0")];
    for (const ww of words) {
      const base = `${d}:${ww}${sub !== undefined ? `.${sub}` : ""}`;
      out.add(bit !== undefined ? `${base}/${bit}` : base);
      if (bit !== undefined) out.add(`${base}/${bit.padStart(2, "0")}`);
    }
  }
  return [...out];
}

export function searchPages(
  docs: { id: string; name: string; pagesText?: string[] }[],
  terms: string[],
  limit = 30,
): DrawingHit[] {
  const hits: DrawingHit[] = [];
  const lower = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 1);
  if (!lower.length) return hits;
  for (const d of docs) {
    (d.pagesText ?? []).forEach((text, i) => {
      const hay = text.toLowerCase();
      const term = lower.find((t) => hay.includes(t));
      if (!term) return;
      const at = hay.indexOf(term);
      hits.push({
        attachmentId: d.id,
        name: d.name,
        page: i + 1,
        snippet: `${at > 60 ? "…" : ""}${text.slice(Math.max(0, at - 60), at + term.length + 80)}…`,
      });
    });
  }
  return hits.slice(0, limit);
}
