// Floating action button — per-device config (localStorage). A draggable
// shortcut button shown on every screen. Enabled + configured from the Settings
// page; positioned by long-pressing and dragging it. Default action: Log Visit.

import { FEATURES, FEATURE_GROUP_TITLES, type FeatureGroup } from '@/lib/feature-catalog';

export type FabConfig = {
  enabled: boolean;
  label: string;
  href: string;
  top: number | null;   // px from top; null = use default placement
  left: number | null;  // px from left; null = use default placement
};

export type FabAction = { label: string; href: string; group: string };

// Every destination the button can point at — built from the app's tab catalog
// (every admin / office / crew / contractor / funder tab) plus a few app-wide shortcuts, so any
// tab in the app can be the button's action. Grouped for the Settings picker.
const GROUP_TITLE: Record<FeatureGroup, string> = Object.fromEntries(
  FEATURE_GROUP_TITLES.map((g) => [g.group, g.title]),
) as Record<FeatureGroup, string>;

const SHORTCUTS: FabAction[] = [
  { group: 'Shortcuts', label: 'New Ticket', href: '/tickets/new' },
  { group: 'Shortcuts', label: 'Messages', href: '/messages' },
  { group: 'Shortcuts', label: 'Settings', href: '/settings' },
  { group: 'Shortcuts', label: 'Home', href: '/' },
];

export const FAB_ACTIONS: FabAction[] = (() => {
  const out: FabAction[] = [...SHORTCUTS];
  const seen = new Set(out.map((a) => a.href));
  for (const f of FEATURES) {
    const href = f.key.slice(f.group.length + 1);    // "group:href" → href
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ group: GROUP_TITLE[f.group] || f.group, label: f.label, href });
  }
  return out;
})();

export const FAB_KEY = 'floating_button';
export const FAB_EVENT = 'floating-button-changed';

const DEFAULT: FabConfig = {
  enabled: false,
  label: 'New Ticket',
  href: '/tickets/new',
  top: null,
  left: null,
};

export function loadFab(): FabConfig {
  if (typeof window === 'undefined') return { ...DEFAULT };
  try {
    const raw = localStorage.getItem(FAB_KEY);
    if (!raw) return { ...DEFAULT };
    return { ...DEFAULT, ...(JSON.parse(raw) as Partial<FabConfig>) };
  } catch {
    return { ...DEFAULT };
  }
}

// Save the whole config and notify any mounted button to refresh.
export function saveFab(cfg: FabConfig): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(FAB_KEY, JSON.stringify(cfg));
    window.dispatchEvent(new Event(FAB_EVENT));
  } catch { /* ignore */ }
}

// Persist just the dragged position WITHOUT firing the change event, so the
// button doesn't re-initialize (and jump) mid-drag.
export function saveFabPosition(top: number, left: number): void {
  if (typeof window === 'undefined') return;
  try {
    const c = loadFab();
    localStorage.setItem(FAB_KEY, JSON.stringify({ ...c, top, left }));
  } catch { /* ignore */ }
}
