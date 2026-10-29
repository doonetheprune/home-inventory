/** Line icons (24×24, drawn with the current text colour). */
import type { ReactNode } from 'react';

const P: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  box: <><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="m3 8 9 5 9-5M12 13v8" /></>,
  scan: <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2M8 8v8M11 8v8M14 8v8M17 8v8" />,
  cart: <><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2.5 3h2.6l2.4 12.2a1 1 0 0 0 1 .8h9.3a1 1 0 0 0 1-.8L21 7H6" /></>,
  more: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  chev: <path d="m9 6 6 6-6 6" />,
  back: <path d="m15 6-6 6 6 6" />,
  down: <path d="m6 9 6 6 6-6" />,
  pin: <><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  battery: <><rect x="2.5" y="7" width="17" height="10" rx="2" /><path d="M22 11v2M6 10v4M9.5 10v4" /></>,
  truck: <><path d="M2 6h11v10H2zM13 9h4.5l3.5 3.5V16h-8" /><circle cx="6" cy="17.5" r="1.8" /><circle cx="17" cy="17.5" r="1.8" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  qr: <><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM18 14h2.5M14 20.5h2.5" /></>,
  print: <><path d="M7 9V3h10v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>,
  heart: <path d="M12 20s-7.5-4.6-9.2-9.4C1.7 7.3 3.9 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.3 0 5.5 3.3 4.4 6.6C19.5 15.4 12 20 12 20z" />,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  grid: <><rect x="3.5" y="3.5" width="17" height="17" rx="2" /><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17" /></>,
  camera: <><path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13.5" r="3.5" /></>,
  tag: <><path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" /><circle cx="7.5" cy="7.5" r="1.4" /></>,
  link: <><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>,
  move: <path d="M4 8h14m-4-4 4 4-4 4M20 16H6m4-4-4 4 4 4" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  zap: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  keyboard: <><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></>,
  drop: <path d="M12 3s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10 12 3 12 3z" />,
  wrench: <path d="M15 4a5 5 0 0 0-4.6 6.9l-6.9 6.9a1.8 1.8 0 0 0 2.6 2.6l6.9-6.9A5 5 0 0 0 20 9l-3 1-2-2 1-3z" />,
  paw: <><circle cx="6.5" cy="9" r="1.8" /><circle cx="10" cy="5.5" r="1.8" /><circle cx="14" cy="5.5" r="1.8" /><circle cx="17.5" cy="9" r="1.8" /><path d="M12 11c-3 0-5.5 3.8-5.5 6.2 0 1.6 1.3 2.3 2.7 2.3 1.2 0 1.8-.6 2.8-.6s1.6.6 2.8.6c1.4 0 2.7-.7 2.7-2.3C17.5 14.8 15 11 12 11z" /></>,
  shield: <><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z" /><path d="m9 12 2 2 4-4" /></>,
  apple: <><path d="M12 7.5c-1.5-1-3-1.4-4.5-1C4.8 7.2 3.6 10 4.3 13.4c.8 4 3.4 7.4 5.6 7.4 1 0 1.3-.5 2.1-.5s1.1.5 2.1.5c2.2 0 4.8-3.4 5.6-7.4.7-3.4-.5-6.2-3.2-6.9-1.5-.4-3 0-4.5 1z" /><path d="M12 7.5c0-2 1-3.5 3-4.2" /></>,
  sparkle: <path d="M12 3c.6 4.6 2.4 6.4 7 7-4.6.6-6.4 2.4-7 7-.6-4.6-2.4-6.4-7-7 4.6-.6 6.4-2.4 7-7zM19 16c.3 1.8 1 2.6 2.8 2.8-1.8.3-2.5 1-2.8 2.8-.3-1.8-1-2.5-2.8-2.8 1.8-.2 2.5-1 2.8-2.8z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  inbox: <><path d="M12 3v9m-4-4 4 4 4-4" /><path d="M3 13h5l1.5 3h5L16 13h5v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /></>,
  book: <><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5z" /><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3" /></>,
  store: <><path d="M3 9.5 4.5 4h15L21 9.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" /><path d="M5 12v8h14v-8M10 20v-5h4v5" /></>,
  nfc: <path d="M6 8.5a5 5 0 0 1 0 7M9.5 6a8.5 8.5 0 0 1 0 12M13 3.5a12 12 0 0 1 0 17" />,
  sliders: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  gift: <><rect x="3.5" y="8" width="17" height="4" rx="1" /><path d="M5 12v8h14v-8M12 8v12M12 8S10.5 4 8 4a2 2 0 0 0 0 4M12 8s1.5-4 4-4a2 2 0 0 1 0 4" /></>,
  jar: <><path d="M8 3h8v3H8z" /><path d="M7 6h10a1 1 0 0 1 1 1v1.5a2 2 0 0 1-.6 1.4l-.4.4V19a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-8.7l-.4-.4A2 2 0 0 1 6 8.5V7a1 1 0 0 1 1-1z" /><path d="M7.2 13.5h9.6" /></>,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14 9l2 2" /></>,
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 21h16" />,
  logout: <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l-4-4 4-4M6 12h10" />,
};

export const CATEGORY_ICONS = ['apple', 'sparkle', 'drop', 'shield', 'paw', 'wrench', 'battery', 'box', 'zap', 'gift', 'book', 'heart'];

export function Icon({ name, size, className = '' }: { name: string; size?: 'sm' | 'lg'; className?: string }) {
  return (
    <svg className={`i ${size ?? ''} ${className}`} viewBox="0 0 24 24" aria-hidden="true">
      {P[name] ?? P.box}
    </svg>
  );
}
