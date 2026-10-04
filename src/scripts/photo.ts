/** Re-encode a browser-readable photo as JPEG without carrying its EXIF metadata. */
export async function toJpegBase64(file: File, maxEdge = 2048): Promise<string> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a JPG, PNG, or WebP image.');
  }
  if (!Number.isFinite(maxEdge) || maxEdge < 1) {
    throw new RangeError('The maximum image size must be positive.');
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error("We couldn't read that photo. Please choose another JPG, PNG, or WebP image.");
  }

  try {
    if (!bitmap.width || !bitmap.height) throw new Error("We couldn't read that photo.");
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error("We couldn't prepare that photo. Please try another image.");

    // JPEG has no transparency; white keeps transparent PNG areas readable.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
      throw new Error("We couldn't prepare that photo. Please try another image.");
    }
    const base64 = dataUrl.slice('data:image/jpeg;base64,'.length);
    if (base64.length * 3 / 4 > 8 * 1024 * 1024 + 2) {
      throw new Error('That photo is still too large after resizing. Please choose a smaller one.');
    }
    return base64;
  } finally {
    bitmap.close();
  }
}
