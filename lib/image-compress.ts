// Browser-side image downscale before upload. Keeps fine detail (serial
// numbers, fine print) readable: caps the long edge at MAX_EDGE and exports at
// QUALITY. Only images are touched; videos/PDFs/etc. pass through untouched,
// and we keep the original if compression wouldn't actually shrink it.

const MAX_EDGE = 2400;
const QUALITY = 0.9;

export async function maybeCompressImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) return file;       // only images
  if (file.type === 'image/gif') return file;             // don't break animation
  // Tiny files aren't worth re-encoding.
  if (file.size < 400 * 1024) return file;

  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', QUALITY),
    );
    if (!blob || blob.size >= file.size) return file;       // no gain — keep original

    const name = file.name.replace(/\.(png|webp|heic|heif|bmp|tiff?)$/i, '.jpg');
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file; // any failure → upload the original
  }
}
