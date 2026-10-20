import { AVATARS } from "@/lib/avatars";

/*
 * Original operator emblems (no third-party art): each avatar is a geometric visor
 * mask drawn in SVG in the avatar's colour. If the player opted to show a photo, the
 * photo is shown instead, clipped to the same frame.
 */

const SHAPES: Record<string, (c: string) => React.ReactNode> = {
  viper: (c) => <path d="M20 34 L50 22 L80 34 L72 48 L50 42 L28 48 Z" fill={c} />,
  ghost: (c) => <><rect x="24" y="30" width="52" height="12" rx="6" fill={c} /><circle cx="50" cy="60" r="4" fill={c} opacity="0.7" /></>,
  cipher: (c) => <><path d="M24 30 H44 L40 44 H24 Z M56 30 H76 V44 H60 Z" fill={c} /><path d="M40 62 H60" stroke={c} strokeWidth="4" /></>,
  volt: (c) => <path d="M54 18 L36 50 H50 L44 78 L66 42 H52 Z" fill={c} />,
  nova: (c) => <><circle cx="50" cy="38" r="12" fill="none" stroke={c} strokeWidth="5" /><path d="M20 38 H34 M66 38 H80" stroke={c} strokeWidth="5" /></>,
  rook: (c) => <><rect x="26" y="30" width="48" height="8" fill={c} /><rect x="26" y="42" width="48" height="4" fill={c} opacity="0.6" /></>,
  ember: (c) => <path d="M50 18 C66 34 70 44 60 58 C58 48 54 46 50 40 C46 48 40 52 40 60 C30 46 34 32 50 18 Z" fill={c} />,
  echo: (c) => <><path d="M26 36 Q50 20 74 36" fill="none" stroke={c} strokeWidth="5" /><path d="M34 46 Q50 36 66 46" fill="none" stroke={c} strokeWidth="5" /></>,
};

export function Avatar({ id, photoUrl, size = 56, label }: { id: string; photoUrl?: string | null; size?: number; label?: string }) {
  const a = AVATARS.find((x) => x.id === id) ?? AVATARS[0];
  const c = `hsl(${a.hue} 100% 60%)`;
  const clip = "polygon(18% 0, 100% 0, 100% 82%, 82% 100%, 0 100%, 0 18%)";
  if (photoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={photoUrl} alt={label ?? a.name} width={size} height={size} style={{ width: size, height: size, objectFit: "cover", clipPath: clip, border: `2px solid ${c}`, background: "#000" }} />
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={label ?? a.name} style={{ clipPath: clip, display: "block", flex: "none" }}>
      <defs>
        <radialGradient id={`ag-${a.id}`} cx="50%" cy="35%" r="70%">
          <stop offset="0" stopColor={`hsl(${a.hue} 80% 18%)`} />
          <stop offset="1" stopColor="#020607" />
        </radialGradient>
      </defs>
      <rect width="100" height="100" fill={`url(#ag-${a.id})`} />
      <path d="M50 8 L84 24 V56 C84 74 68 88 50 94 C32 88 16 74 16 56 V24 Z" fill="#071313" stroke={c} strokeWidth="2.5" opacity="0.95" />
      <g style={{ filter: `drop-shadow(0 0 4px ${c})` }}>{SHAPES[a.id]?.(c)}</g>
      <path d="M30 72 H70" stroke={c} strokeWidth="2" opacity="0.5" />
    </svg>
  );
}

export function avatarHue(id: string): number {
  return (AVATARS.find((x) => x.id === id) ?? AVATARS[0]).hue;
}
