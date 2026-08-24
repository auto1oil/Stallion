'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { unreadCount } from '@/lib/messages';

const POLL_MS = 30_000;

// Top-bar message-bubble icon with an unread red badge, sitting next to the
// notification bell. `href` differs by surface (/messages for staff,
// /shop/messages for customers).
export default function MessageBubble({
  userId,
  href,
  className = 'text-gray-600 hover:text-brand-700',
}: {
  userId: string;
  href: string;
  className?: string;
}) {
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    async function load() {
      const n = await unreadCount(userId).catch(() => 0);
      if (alive) setUnread(n);
    }
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // Re-check when navigating (e.g. after reading on the messages page).
  }, [userId, pathname]);

  return (
    <Link
      href={href}
      aria-label={`Messages (${unread} unread)`}
      title="Messages"
      className={`relative focus:outline-none ${className}`}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      {unread > 0 && (
        <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold bg-red-500 text-white rounded-full">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}
