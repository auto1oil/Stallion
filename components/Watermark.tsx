'use client';

// Traceable watermark overlay. The web platform can't BLOCK screenshots or
// screen recording (that's native-app-only), so instead we tile a faint,
// diagonal watermark of the signed-in user's name + today's date across every
// screen. It doesn't stop a capture, but any leaked screenshot is traceable to
// who took it. pointer-events-none so it never blocks interaction; renders
// nothing when signed out (login/public pages).

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase-browser';

export default function Watermark() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user || cancelled) return;
      const { data } = await supabase.from('profiles').select('full_name, email').eq('id', user.id).single();
      const who = data?.full_name || data?.email || user.email || 'user';
      const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      if (!cancelled) setLabel(`${who} · ${date}`);
    });
    return () => { cancelled = true; };
  }, []);

  if (!label) return null;

  // Tile the label diagonally as a repeating SVG background.
  const text = encodeURIComponent(label);
  const svg =
    `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='340' height='200'>` +
    `<text x='0' y='100' transform='rotate(-30 0 100)' font-family='sans-serif' font-size='15' ` +
    `fill='%23000000' fill-opacity='0.05'>${text}</text></svg>`;

  return (
    <div
      aria-hidden
      className="fixed inset-0 z-[9999] pointer-events-none select-none"
      style={{ backgroundImage: `url("${svg}")`, backgroundRepeat: 'repeat' }}
    />
  );
}
