'use client';
import { useEffect, useRef, useState } from 'react';

// Pull-to-refresh for the installed PWA. When the app runs standalone (added
// to the home screen), the browser's native pull-to-refresh is gone, so we
// reproduce it: pulling down from the very top past a threshold reloads.
// In a normal browser tab we do nothing — the native gesture already works.
export default function PullToRefresh() {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullRef = useRef(0);
  const startY = useRef<number | null>(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (!standalone) return;

    const THRESHOLD = 70;   // px pulled (after resistance) needed to trigger
    const MAX = 140;
    const topPos = () => window.scrollY || document.documentElement.scrollTop || 0;
    const apply = (v: number) => { pullRef.current = v; setPull(v); };

    const onStart = (e: TouchEvent) => {
      if (refreshingRef.current || topPos() > 0) { startY.current = null; return; }
      startY.current = e.touches[0].clientY;
    };
    const onMove = (e: TouchEvent) => {
      if (startY.current == null || refreshingRef.current) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0 || topPos() > 0) { apply(0); return; }
      apply(Math.min(MAX, dy * 0.5));      // resistance
      if (e.cancelable) e.preventDefault(); // stop the page rubber-banding
    };
    const onEnd = () => {
      if (startY.current == null) return;
      startY.current = null;
      if (pullRef.current >= THRESHOLD) {
        refreshingRef.current = true;
        setRefreshing(true);
        apply(THRESHOLD);
        window.location.reload();
      } else {
        apply(0);
      }
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, []);

  if (pull <= 0 && !refreshing) return null;

  const spinning = refreshing || pull >= 70;
  return (
    <div
      className="fixed left-0 right-0 top-0 z-[60] flex justify-center pointer-events-none"
      style={{
        transform: `translateY(${Math.max(0, pull - 16)}px)`,
        transition: refreshing ? 'transform 150ms ease-out' : undefined,
      }}
    >
      <div className="mt-2 h-9 w-9 rounded-full bg-white shadow-md border border-gray-200 flex items-center justify-center">
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#0b3a8a"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={spinning ? 'animate-spin' : ''}
          style={!spinning ? { transform: `rotate(${pull * 2}deg)` } : undefined}
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </div>
    </div>
  );
}
