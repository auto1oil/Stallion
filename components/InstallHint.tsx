'use client';
import { useEffect, useState } from 'react';

// Nudge phone users to put the app on their home screen. On iPhones, push
// notifications (new load offered, ticket submitted) only work once the app
// is installed — and nobody knows that unless the app says so. Shown once,
// dismissible, never on desktop, gone the moment the app runs installed.

const KEY = 'stallion-install-hint-dismissed';

type InstallPromptEvent = Event & { prompt: () => Promise<void> };

export default function InstallHint() {
  const [show, setShow] = useState(false);
  const [ios, setIos] = useState(false);
  const [installEvt, setInstallEvt] = useState<InstallPromptEvent | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return;
    }
    const nav = navigator as Navigator & { standalone?: boolean };
    const standalone =
      window.matchMedia?.('(display-mode: standalone)')?.matches || nav.standalone === true;
    if (standalone) return;
    const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const isAndroid = /Android/i.test(navigator.userAgent);
    if (isIos) {
      setIos(true);
      setShow(true);
      return;
    }
    if (!isAndroid) return;
    // Android: only offer once the browser says it can actually prompt.
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as InstallPromptEvent);
      setShow(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  function dismiss() {
    try { localStorage.setItem(KEY, '1'); } catch { /* private mode — it'll just re-offer */ }
    setShow(false);
  }

  if (!show) return null;

  return (
    <div className="bg-accent-50 border-b border-gray-200 text-sm text-gray-800">
      <div className="max-w-5xl mx-auto px-4 py-2 flex items-center gap-3">
        <span className="min-w-0 flex-1">
          {ios ? (
            <>
              Put this app on your home screen to get load and ticket alerts: tap{' '}
              <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
            </>
          ) : (
            <>Install this app to get load and ticket alerts.</>
          )}
        </span>
        {!ios && installEvt && (
          <button
            onClick={() => { installEvt.prompt(); dismiss(); }}
            className="shrink-0 px-3 py-1 rounded-md bg-brand-700 text-white text-xs font-semibold hover:bg-brand-900"
          >
            Install
          </button>
        )}
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 px-1 text-gray-500 hover:text-gray-800"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
