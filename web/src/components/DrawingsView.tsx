import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../lib/machines";
import type { Location } from "../lib/nav";
import { renderPdfPage, searchPages } from "../lib/pdf";
import { FilePicker } from "./FilePicker";

export const DRAWING_ACCEPT = ".pdf,application/pdf,image/*";

function fmtSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.round(e[0]?.contentRect.width ?? 800)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Renders one PDF page (or an image attachment) to fit the available width. */
export function DrawingPage({ attachment, page, zoom = 1 }: { attachment: Attachment; page: number; zoom?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isPdf = attachment.mime === "application/pdf";
  const imageUrl = useMemo(() => (isPdf ? null : URL.createObjectURL(attachment.blob)), [attachment, isPdf]);
  useEffect(() => () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);
  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    setError(null);
    const px = Math.min(3000, Math.round(width * zoom * (window.devicePixelRatio || 1)));
    renderPdfPage(attachment.id, attachment.blob, page, px)
      .then((url) => !cancelled && setSrc(url))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [attachment, page, width, zoom, isPdf]);
  return (
    <div ref={ref} className="drawing-page">
      {error ? <div className="notice error">{error}</div> : null}
      {isPdf ? (
        src ? (
          <img src={src} alt={`${attachment.name} page ${page}`} style={{ width: `${zoom * 100}%` }} />
        ) : (
          <div className="busy inline">
            <span className="spinner" aria-hidden /> Rendering page {page}…
          </div>
        )
      ) : imageUrl ? (
        <img src={imageUrl} alt={attachment.name} style={{ width: `${zoom * 100}%` }} />
      ) : null}
    </div>
  );
}

export function DrawingsView({
  attachments,
  selectedId,
  page,
  onAdd,
  onDelete,
  onNavigate,
}: {
  attachments: Attachment[];
  selectedId?: string;
  page?: number;
  onAdd: (files: File[]) => void;
  onDelete: (id: string) => void;
  onNavigate: (loc: Location) => void;
}) {
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const selected = attachments.find((a) => a.id === selectedId) ?? attachments[0];
  const current = selected && selected.id === selectedId ? (page ?? 1) : 1;
  const hits = useMemo(() => (query.trim() ? searchPages(attachments, [query.trim()], 60) : []), [attachments, query]);
  const go = (id: string, p: number) => onNavigate({ view: "drawings", id, page: p });
  const scanned = selected?.mime === "application/pdf" && (selected.pagesText ?? []).every((t) => t.length < 20);

  return (
    <div className="view drawings">
      <header className="view-head">
        <div className="eyebrow">Electrical drawings</div>
        <div className="view-title-row">
          <h1 className="view-title">Drawings</h1>
          <span className="view-meta">{attachments.length} file{attachments.length === 1 ? "" : "s"}</span>
          <FilePicker className="btn primary small" accept={DRAWING_ACCEPT} onFiles={onAdd} title="Add PDF drawings or photos of drawings">
            + Add drawings
          </FilePicker>
        </div>
        <p className="view-desc">
          Stored with this machine. The text in PDFs is indexed, so tags and I/O addresses link to the pages that show them — and Ask AI can
          search and look at them.
        </p>
        {attachments.length ? (
          <div className="toolbar">
            <input className="input" placeholder="Search drawings — address, wire number, device…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        ) : null}
      </header>

      {attachments.length === 0 ? (
        <div className="library-empty">
          <h2>No drawings yet</h2>
          <p className="muted">Add the machine&apos;s electrical drawings as PDF, or photos of the pages.</p>
          <FilePicker className="btn primary" accept={DRAWING_ACCEPT} onFiles={onAdd}>
            + Add drawings
          </FilePicker>
        </div>
      ) : (
        <div className="drawings-layout">
          <aside className="drawings-side">
            {query.trim() ? (
              <>
                <h3 className="section-label">
                  Matches <span className="count">{hits.length}</span>
                </h3>
                {hits.length === 0 ? <p className="muted small">No text matches. Scanned drawings can&apos;t be searched — ask the AI to look at pages instead.</p> : null}
                <ul className="hits">
                  {hits.map((h, i) => (
                    <li key={i}>
                      <button type="button" className="hit" onClick={() => go(h.attachmentId, h.page)}>
                        <span className="mn">p.{h.page}</span>
                        <span className="hit-loc">{h.name}</span>
                        <span className="hit-addr">{h.snippet}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <ul className="drawing-files">
                {attachments.map((a) => (
                  <li key={a.id} className={a.id === selected?.id ? "active" : ""}>
                    <button type="button" className="drawing-file" onClick={() => go(a.id, 1)}>
                      <span className="drawing-name">{a.name}</span>
                      <span className="muted small">
                        {a.pageCount ? `${a.pageCount} pages · ` : ""}
                        {fmtSize(a.size)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Remove drawing"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => window.confirm(`Remove “${a.name}” from this machine?`) && onDelete(a.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          {selected ? (
            <section className="drawing-viewer">
              <div className="drawing-bar">
                <span className="drawing-name">{selected.name}</span>
                {selected.pageCount ? (
                  <span className="pager">
                    <button type="button" className="icon-btn" disabled={current <= 1} onClick={() => go(selected.id, current - 1)} aria-label="Previous page">
                      ‹
                    </button>
                    <span className="small">
                      {current} / {selected.pageCount}
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={current >= selected.pageCount}
                      onClick={() => go(selected.id, current + 1)}
                      aria-label="Next page"
                    >
                      ›
                    </button>
                  </span>
                ) : null}
                <span className="toggles">
                  {[1, 1.5, 2.5].map((z) => (
                    <button key={z} type="button" className={`toggle ${zoom === z ? "on" : ""}`} onClick={() => setZoom(z)}>
                      {z === 1 ? "Fit" : `${z}×`}
                    </button>
                  ))}
                </span>
              </div>
              {scanned ? <p className="muted small">This PDF is scanned (no text layer) — search can&apos;t read it, but Ask AI can look at the pages.</p> : null}
              <div className="drawing-scroll">
                <DrawingPage attachment={selected} page={current} zoom={zoom} />
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
