import { useRef, type ReactNode } from "react";

export const EXPORT_ACCEPT = ".pc5,.sy6,.sy5,.l5k,.l5x,.slc,.csv";

/** A button that opens the OS file picker for PLC export files. */
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
  return (
    <>
      <button type="button" className={className} title={title} onClick={() => ref.current?.click()}>
        {children}
      </button>
      <input
        ref={ref}
        type="file"
        multiple={multiple}
        accept={accept}
        {...(capture ? { capture } : {})}
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </>
  );
}
