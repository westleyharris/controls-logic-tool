import { useRef, type ReactNode } from "react";

export const EXPORT_ACCEPT = ".pc5,.sy6,.sy5,.l5k,.l5x,.slc,.csv,.mer,.apa";
/** Operator panel files only (FactoryTalk View ME runtime / project archive). */
export const PANEL_ACCEPT = ".mer,.apa";

/**
 * Phones and tablets: iOS and Android only offer files whose type they know,
 * so a filter of PLC extensions (.L5K, .SLC, .PC5…) greys every export out.
 * There we show all files and check the extension after picking instead.
 */
function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent;
  return (
    /iPhone|iPad|iPod|Android/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || // iPadOS asks for the desktop site
    !!window.matchMedia?.("(pointer: coarse)").matches
  );
}

const extOf = (name: string) => name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";

/** A button that opens the OS file picker (PLC export files by default). */
export function FilePicker({
  onFiles,
  className,
  children,
  title,
  accept = EXPORT_ACCEPT,
  multiple = true,
  capture,
}: {
  onFiles: (files: File[]) => void;
  className?: string;
  children: ReactNode;
  title?: string;
  accept?: string;
  multiple?: boolean;
  /** Open the phone camera directly ("environment" = rear camera). */
  capture?: "environment" | "user";
}) {
  const ref = useRef<HTMLInputElement>(null);
  // Only plain extension lists need this; "image/*" and PDFs are types phones know.
  const extensions = accept.split(",").map((a) => a.trim().toLowerCase());
  const extensionOnly = extensions.every((a) => a.startsWith("."));
  const unfiltered = extensionOnly && isTouchDevice();

  return (
    <>
      <button type="button" className={className} title={title} onClick={() => ref.current?.click()}>
        {children}
      </button>
      <input
        ref={ref}
        type="file"
        multiple={multiple}
        {...(unfiltered ? {} : { accept })}
        {...(capture ? { capture } : {})}
        hidden
        onChange={(e) => {
          let files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (extensionOnly) {
            const wrong = files.filter((f) => !extensions.includes(extOf(f.name)));
            files = files.filter((f) => extensions.includes(extOf(f.name)));
            if (wrong.length) {
              window.alert(
                `${wrong.map((f) => f.name).join(", ")} ${wrong.length === 1 ? "isn't" : "aren't"} ${accept === PANEL_ACCEPT ? "a panel file" : "a PLC export"}.\n\n` +
                  (accept === PANEL_ACCEPT
                    ? "Pick the PanelView Plus runtime file (.MER) or the FactoryTalk View project archive (.APA)."
                    : "Pick the .L5K or .L5X (ControlLogix/CompactLogix), the .SLC (SLC 500), or the .PC5 together with its .SY6 (PLC-5). The panel's .MER or .APA can go with it.") +
                  (files.length ? "\n\nContinuing with the other files." : ""),
              );
            }
          }
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
