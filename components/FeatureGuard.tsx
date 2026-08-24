'use client';

// Hard-gate for hidden tabs: if a master admin has switched a tab off for this
// role, block direct-URL access to it (not just hide it from the menu). Mounted
// in each role layout. Redirects to a safe page when the current path is a
// disabled feature.

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import { FEATURES, type FeatureGroup } from '@/lib/feature-catalog';

// Same rule as the nav's active check: exact match for the role index routes,
// prefix match for everything else.
function pathMatches(pathname: string, href: string): boolean {
  if (['/admin', '/driver', '/tickets', '/work-orders', '/contractor', '/funder'].includes(href)) {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(href + '/');
}

export default function FeatureGuard({ group }: { group: FeatureGroup }) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!pathname) return;
    const supabase = createClient();
    let cancelled = false;
    supabase.from('feature_flags').select('key').eq('enabled', false).then(({ data }) => {
      if (cancelled) return;
      const disabled = new Set(((data as { key: string }[]) || []).map((r) => r.key));
      const hit = FEATURES.some((f) => {
        if (f.group !== group || !disabled.has(f.key)) return false;
        const href = f.key.slice(group.length + 1); // "group:href" → href
        return pathMatches(pathname, href);
      });
      if (hit) router.replace('/account');
    });
    return () => { cancelled = true; };
  }, [pathname, group, router]);

  return null;
}
