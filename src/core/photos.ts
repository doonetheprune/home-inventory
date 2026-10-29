/** Recognising photos by their bytes, for uploads and for photos Larder downloads. */

/** The photo format, judged from the file's first bytes, or null if it isn't one we accept. */
export function photoType(d: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...d.subarray(from, to));
  if (d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}
