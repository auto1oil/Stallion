'use client';
import { useEffect, useState } from 'react';
import { listBoardMedia, attachmentUrl, type Message } from '@/lib/messages';

// Full-screen grid of every photo/video ever sent in a board, newest first,
// with the date under each. Files (non-image/video) are skipped here.
export default function MediaGallery({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const [items, setItems] = useState<Message[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const media = (await listBoardMedia(boardId)).filter(
        (m) => (m.attachment_type || '').startsWith('image/') || (m.attachment_type || '').startsWith('video/'),
      );
      setItems(media);
      setLoading(false);
      // Sign URLs in parallel.
      const entries = await Promise.all(
        media.map(async (m) => [m.id, (await attachmentUrl(m.attachment_path!)) || ''] as const),
      );
      setUrls(Object.fromEntries(entries));
    })();
  }, [boardId]);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 sticky top-0 bg-white rounded-t-lg">
          <span className="font-semibold">Photos &amp; videos</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <div className="p-4">
          {loading ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No photos or videos yet.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {items.map((m) => {
                const url = urls[m.id];
                const isVideo = (m.attachment_type || '').startsWith('video/');
                const date = new Date(m.created_at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
                return (
                  <div key={m.id} className="text-center">
                    <a href={url || undefined} target="_blank" rel="noopener noreferrer" className="block">
                      {url ? (
                        isVideo
                          ? <video src={url} className="w-full h-24 object-cover rounded bg-gray-100" />
                          // eslint-disable-next-line @next/next/no-img-element
                          : <img src={url} alt="" className="w-full h-24 object-cover rounded bg-gray-100" />
                      ) : (
                        <div className="w-full h-24 rounded bg-gray-100 animate-pulse" />
                      )}
                    </a>
                    <div className="text-[10px] text-gray-500 mt-0.5">{date}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
