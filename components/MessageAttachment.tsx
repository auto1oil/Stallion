'use client';
import { useEffect, useState } from 'react';
import { attachmentUrl } from '@/lib/messages';

// Renders a message attachment: inline image/video, or a download chip for
// other files. Signs the storage URL (the bucket is private).
export default function MessageAttachment({
  path,
  type,
  name,
}: {
  path: string;
  type: string | null;
  name: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    attachmentUrl(path).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [path]);

  const isImage = (type || '').startsWith('image/');
  const isVideo = (type || '').startsWith('video/');

  if (!url) {
    return <div className="mt-1 text-xs text-gray-400">Loading attachment…</div>;
  }
  if (isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block mt-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name || 'image'} className="max-w-[220px] max-h-[220px] rounded-lg object-cover" />
      </a>
    );
  }
  if (isVideo) {
    return <video src={url} controls className="max-w-[240px] max-h-[240px] rounded-lg mt-1" />;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg text-sm text-gray-700 hover:bg-gray-200"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      {name || 'Download file'}
    </a>
  );
}
