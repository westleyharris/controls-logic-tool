/**
 * One consistent line-icon set (24×24, 2px stroke, currentColor) so buttons
 * look the same on every phone and computer instead of depending on emoji fonts.
 */

const PATHS = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "chevron-down": <path d="m6 9 6 6 6-6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4.6-4.6" />
    </>
  ),
  settings: (
    <>
      <path d="M19.32 9.97 21.89 10.49v3.02l-2.57.52-.71 1.72 1.45 2.18-2.13 2.13-2.18-1.45-1.72.71-.52 2.57h-3.02l-.52-2.57-1.72-.71-2.18 1.45-2.13-2.13 1.45-2.18-.71-1.72-2.57-.52v-3.02l2.57-.52.71-1.72-1.45-2.18 2.13-2.13 2.18 1.45 1.72-.71.52-2.57h3.02l.52 2.57 1.72.71 2.18-1.45 2.13 2.13-1.45 2.18z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </>
  ),
  moon: <path d="M20.5 14.1A8.5 8.5 0 1 1 9.9 3.5a6.6 6.6 0 0 0 10.6 10.6z" />,
  cloud: <path d="M17.5 19H8a6 6 0 1 1 5.8-7.5h1.2a3.75 3.75 0 0 1 2.5 7.5z" />,
  "cloud-check": (
    <>
      <path d="M17.5 19H8a6 6 0 1 1 5.8-7.5h1.2a3.75 3.75 0 0 1 2.5 7.5z" />
      <path d="m9 14.5 2 2 4-4" />
    </>
  ),
  sparkles: (
    <>
      <path d="M10 3.5 11.6 8.4 16.5 10l-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" />
      <path d="M18 14v5M15.5 16.5h5M18.5 3v3M17 4.5h3" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />,
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M18.5 10.5v.5a6.5 6.5 0 0 1-13 0v-.5M12 17.5v4M8.5 21.5h7" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4h-5L7.5 7H4.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  speaker: (
    <>
      <path d="M11 5 6.5 9H3v6h3.5l4.5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9.2 9.2 0 0 1 0 13" />
    </>
  ),
  "speaker-off": (
    <>
      <path d="M11 5 6.5 9H3v6h3.5l4.5 4z" />
      <path d="m16 9.5 5 5M21 9.5l-5 5" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  pin: (
    <>
      <path d="M19.5 10c0 5.5-7.5 11.5-7.5 11.5S4.5 15.5 4.5 10a7.5 7.5 0 0 1 15 0z" />
      <circle cx="12" cy="10" r="2.75" />
    </>
  ),
  note: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  external: <path d="M15 3h6v6M10 14 21 3M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5" />,
  check: <path d="M20 6 9 17l-5-5" />,
  alert: (
    <>
      <path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4.5M12 17h.01" />
    </>
  ),
  "alert-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  send: <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />,
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-4.5-4.5L5 21" />
    </>
  ),
  refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  "log-out": <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  download: <path d="M12 3v12M6.5 10.5 12 16l5.5-5.5M4 20h16" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className, title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
