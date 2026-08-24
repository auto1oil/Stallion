'use client';

// Small round avatar: shows the uploaded profile photo, or the person's
// initials on a colored disc when none is set. Used for message read-receipt
// bubbles and anywhere we show "who".

function initials(name: string | null | undefined, email: string | null | undefined): string {
  const src = (name || '').trim() || (email || '').trim();
  if (!src) return '?';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

// Deterministic color from the id/name so each person keeps a stable hue.
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export default function Avatar({
  name,
  email,
  url,
  seed,
  size = 28,
  title,
}: {
  name?: string | null;
  email?: string | null;
  url?: string | null;
  seed?: string;
  size?: number;
  title?: string;
}) {
  const dim = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  const label = title ?? (name || email || '');
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={label}
        title={label}
        className="rounded-full object-cover bg-gray-100 border border-white shadow-sm"
        style={dim}
      />
    );
  }
  const h = hue(seed || name || email || '?');
  return (
    <span
      title={label}
      className="inline-flex items-center justify-center rounded-full font-semibold text-white border border-white shadow-sm select-none"
      style={{ ...dim, backgroundColor: `hsl(${h} 55% 45%)` }}
    >
      {initials(name, email)}
    </span>
  );
}
