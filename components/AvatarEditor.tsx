'use client';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Dependency-free avatar cropper: drag to move, slider/wheel to zoom, then it
// exports a centered square at a fixed output size (so big phone photos get
// resized before upload).
//
// Panning is imperative: the drag handler writes the image transform directly
// to the DOM (no React re-render per move), so it stays smooth even with a
// large source photo. React state only holds zoom (changes the rendered size).

const VIEW = 280; // on-screen crop circle, px
const OUT = 512;  // exported image, px

export default function AvatarEditor({
  file,
  onCancel,
  onSave,
}: {
  file: File;
  onCancel: () => void;
  onSave: (blob: Blob) => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  // Live pan offset lives in refs (not state) so dragging never re-renders.
  const txRef = useRef(0);
  const tyRef = useRef(0);
  const natRef = useRef<{ w: number; h: number } | null>(null);

  const [src, setSrc] = useState('');
  const [ready, setReady] = useState(false);
  const [scale, setScale] = useState(1);
  const [minScale, setMinScale] = useState(1);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const clampOffset = useCallback((x: number, y: number, s: number) => {
    const nat = natRef.current;
    if (!nat) return { x, y };
    const minX = VIEW - nat.w * s;
    const minY = VIEW - nat.h * s;
    return { x: Math.min(0, Math.max(minX, x)), y: Math.min(0, Math.max(minY, y)) };
  }, []);

  const applyTransform = useCallback(() => {
    if (imgRef.current) {
      imgRef.current.style.transform = `translate3d(${txRef.current}px, ${tyRef.current}px, 0)`;
    }
  }, []);

  function onImgLoad(e: React.SyntheticEvent<HTMLImageElement>) {
    const img = e.currentTarget;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    natRef.current = { w, h };
    const min = Math.max(VIEW / w, VIEW / h); // cover the circle
    txRef.current = (VIEW - w * min) / 2;
    tyRef.current = (VIEW - h * min) / 2;
    setMinScale(min);
    setScale(min);
    setReady(true);
    applyTransform();
  }

  // When zoom changes the rendered size, re-clamp + re-apply the transform.
  useLayoutEffect(() => {
    const c = clampOffset(txRef.current, tyRef.current, scale);
    txRef.current = c.x;
    tyRef.current = c.y;
    applyTransform();
  }, [scale, clampOffset, applyTransform]);

  function zoomTo(next: number) {
    const ns = Math.max(minScale, Math.min(minScale * 5, next));
    // Keep the viewport center anchored while zooming.
    const cen = VIEW / 2;
    const k = ns / scale;
    const c = clampOffset(cen - (cen - txRef.current) * k, cen - (cen - tyRef.current) * k, ns);
    txRef.current = c.x;
    tyRef.current = c.y;
    setScale(ns);
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, tx: txRef.current, ty: tyRef.current };
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const c = clampOffset(d.tx + (e.clientX - d.x), d.ty + (e.clientY - d.y), scale);
    txRef.current = c.x;
    tyRef.current = c.y;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        applyTransform();
      });
    }
  }
  function onPointerUp() {
    dragRef.current = null;
  }

  function save() {
    const nat = natRef.current;
    if (!nat || !imgRef.current) return;
    setSaving(true);
    const canvas = document.createElement('canvas');
    canvas.width = OUT;
    canvas.height = OUT;
    const ctx = canvas.getContext('2d');
    if (!ctx) { setSaving(false); return; }
    const sX = -txRef.current / scale;
    const sY = -tyRef.current / scale;
    const sSize = VIEW / scale;
    ctx.drawImage(imgRef.current, sX, sY, sSize, sSize, 0, 0, OUT, OUT);
    canvas.toBlob(
      (blob) => {
        setSaving(false);
        if (blob) onSave(blob);
      },
      'image/jpeg',
      0.9,
    );
  }

  const nat = natRef.current;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-lg p-4 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-semibold mb-3">Adjust photo</h3>
        <div
          className="relative mx-auto overflow-hidden rounded-full bg-gray-100 touch-none select-none cursor-move"
          style={{ width: VIEW, height: VIEW }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => zoomTo(scale * (e.deltaY < 0 ? 1.06 : 0.94))}
        >
          {src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              ref={imgRef}
              src={src}
              alt=""
              onLoad={onImgLoad}
              draggable={false}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: ready && nat ? nat.w * scale : 'auto',
                height: ready && nat ? nat.h * scale : 'auto',
                maxWidth: 'none',
                willChange: 'transform',
                transform: 'translate3d(0,0,0)',
              }}
            />
          )}
        </div>
        <div className="flex items-center gap-2 mt-4">
          <span className="text-xs text-gray-500">Zoom</span>
          <input
            type="range"
            min={minScale}
            max={minScale * 5}
            step={0.01}
            value={scale}
            onChange={(e) => zoomTo(Number(e.target.value))}
            className="flex-1"
          />
        </div>
        <p className="text-[11px] text-gray-400 mt-1">Drag to move · slider or scroll to zoom</p>
        <div className="flex gap-2 mt-4">
          <button
            onClick={save}
            disabled={saving || !ready}
            className="flex-1 px-3 py-2 text-sm bg-brand-700 text-white rounded-md hover:bg-brand-900 disabled:opacity-50 font-medium"
          >
            {saving ? 'Saving…' : 'Save photo'}
          </button>
          <button onClick={onCancel} className="px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
