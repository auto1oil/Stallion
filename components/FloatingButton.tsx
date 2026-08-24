'use client';

// A movable floating shortcut button shown on every screen (mounted globally).
// Tap it to run its action (default: Log visit). Press-and-LONG-HOLD then drag
// to move it; the position is remembered per device. Enable + configure it from
// the Settings page. Kept green like the Log-visit button.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadFab, saveFabPosition, FAB_EVENT, type FabConfig } from '@/lib/floating-button';

const HOLD_MS = 350;       // press this long to start moving it
const MOVE_CANCEL = 8;     // px of movement before the hold that cancels it (scroll)

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export default function FloatingButton() {
  const router = useRouter();
  const [cfg, setCfg] = useState<FabConfig | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<number | null>(null);
  const drag = useRef({ startX: 0, startY: 0, offX: 0, offY: 0, moved: false, active: false });

  // Load config + live-update when Settings changes it (or another tab does).
  useEffect(() => {
    const read = () => setCfg(loadFab());
    read();
    window.addEventListener(FAB_EVENT, read);
    window.addEventListener('storage', read);
    return () => { window.removeEventListener(FAB_EVENT, read); window.removeEventListener('storage', read); };
  }, []);

  // Place the button: saved spot, else top-right next to the message cloud.
  useEffect(() => {
    if (!cfg?.enabled || typeof window === 'undefined') { setPos(null); return; }
    const w = window.innerWidth, h = window.innerHeight;
    const defLeft = Math.max(8, w - 150);
    const top = cfg.top ?? 12;
    const left = cfg.left ?? defLeft;
    setPos({ top: clamp(top, 4, h - 52), left: clamp(left, 4, w - 64) });
  }, [cfg?.enabled, cfg?.top, cfg?.left]);

  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; } };

  const onDown = useCallback((e: React.PointerEvent) => {
    const el = btnRef.current; if (!el) return;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    drag.current = { startX: e.clientX, startY: e.clientY, offX: e.clientX - rect.left, offY: e.clientY - rect.top, moved: false, active: false };
    clearHold();
    holdTimer.current = window.setTimeout(() => {
      drag.current.active = true;
      setDragging(true);
      if (navigator.vibrate) try { navigator.vibrate(12); } catch { /* ignore */ }
    }, HOLD_MS);
  }, []);

  const onMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.active) {
      // Moved before the long-press fired → treat as scroll, not a tap/drag.
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > MOVE_CANCEL) { d.moved = true; clearHold(); }
      return;
    }
    const el = btnRef.current;
    const bw = el?.offsetWidth ?? 80, bh = el?.offsetHeight ?? 40;
    setPos({
      top: clamp(e.clientY - d.offY, 4, window.innerHeight - bh - 4),
      left: clamp(e.clientX - d.offX, 4, window.innerWidth - bw - 4),
    });
  }, []);

  const onUp = useCallback(() => {
    clearHold();
    const d = drag.current;
    if (d.active) {
      setDragging(false);
      d.active = false;
      setPos((p) => { if (p) saveFabPosition(p.top, p.left); return p; });
    } else if (!d.moved) {
      const c = loadFab();
      if (c.href) router.push(c.href);
    }
  }, [router]);

  if (!cfg?.enabled || !pos) return null;

  return (
    <button
      ref={btnRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      title={`${cfg.label || 'Log Visit'} — long-press to move`}
      style={{ top: pos.top, left: pos.left, touchAction: 'none' }}
      className={`fixed z-40 px-3 py-1.5 rounded-full bg-green-600 text-white text-xs font-semibold shadow-lg select-none ${
        dragging ? 'ring-4 ring-green-300 scale-105 cursor-grabbing' : 'hover:bg-green-700 cursor-pointer'
      }`}
    >
      {cfg.label || 'Log Visit'}
    </button>
  );
}
