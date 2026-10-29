/** The QR codes on labels (drawn by the web SDK's QrCode with qrcode-generator) read back with ZXing, the decoder Larder's scanner uses. */
import { describe, expect, it } from 'vitest';
import qrcode from 'qrcode-generator';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';

describe('label QR codes', () => {
  it('decode to exactly what was encoded', () => {
    for (const value of ['larder:place:6b1f2c3e-1d2a-4f5b-9c8d-7e6f5a4b3c2d', 'https://larder.example.com/#/places/6b1f2c3e-1d2a-4f5b-9c8d-7e6f5a4b3c2d']) {
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const n = qr.getModuleCount();
      const scale = 6;
      const quiet = 4;
      const size = (n + quiet * 2) * scale;
      const lum = new Uint8ClampedArray(size * size).fill(255);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (!qr.isDark(r, c)) continue;
          for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) lum[((r + quiet) * scale + y) * size + (c + quiet) * scale + x] = 0;
        }
      }
      const text = new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, size, size)))).getText();
      expect(text).toBe(value);
    }
  });
});
