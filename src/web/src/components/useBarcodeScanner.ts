/**
 * Reads barcodes and QR codes from the phone camera. Uses the browser's
 * built-in BarcodeDetector where there is one (Chrome on Android) and the
 * ZXing library elsewhere (iPhone Safari, Firefox). Cameras need HTTPS.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

type Detector = { detect(source: HTMLVideoElement | ImageBitmap): Promise<Array<{ rawValue: string }>> };
declare global {
  interface Window {
    BarcodeDetector?: { new (opts?: { formats?: string[] }): Detector; getSupportedFormats?(): Promise<string[]> };
  }
}

export type CameraState = 'off' | 'starting' | 'on' | 'error';

/**
 * The kinds of code Larder reads: products (EAN, UPC), shop item numbers (Code 128)
 * and its own labels (QR, Data Matrix). Leaving out the rest (ITF, Codabar, Code 39…)
 * stops a product's barcode, half in view, being misread as one of those.
 */
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code', 'data_matrix'];
/** A code counts once it's read the same way twice in a row, so a blurred frame can't stand in for it. */
const CONFIRM_WITHIN_MS = 1500;

export function cameraProblem(): string | null {
  if (!window.isSecureContext) return 'Camera scanning needs a secure (https) address. Open Larder through Home Assistant, Nabu Casa, Tailscale or your own HTTPS address, or use a USB scanner or type the code.';
  if (!navigator.mediaDevices?.getUserMedia) return "This browser can't use the camera. Type the code instead, or use a USB scanner.";
  return null;
}

/**
 * The camera, reading codes as they come into view. While `paused` (Add by photo, lining up the
 * photo), codes in view are left alone: the camera stays on, but nothing is read and the phone doesn't buzz.
 */
export function useBarcodeScanner(video: RefObject<HTMLVideoElement | null>, active: boolean, onCode: (code: string) => void, paused = false) {
  const [state, setState] = useState<CameraState>('off');
  const [error, setError] = useState<string | null>(null);
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const seen = useRef<{ code: string; at: number; times: number }>({ code: '', at: 0, times: 0 });
  const handler = useRef(onCode);
  handler.current = onCode;
  const pause = useRef(paused);
  pause.current = paused;

  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    const problem = cameraProblem();
    if (problem) {
      setError(problem);
      setState('error');
      return;
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let zxingStop: (() => void) | undefined;
    setState('starting');
    setError(null);

    const emit = (code: string) => {
      if (pause.current) {
        seen.current = { code: '', at: 0, times: 0 };
        return;
      }
      const now = Date.now();
      const s = seen.current;
      seen.current = code === s.code && now - s.at < CONFIRM_WITHIN_MS ? { code, at: now, times: s.times + 1 } : { code, at: now, times: 1 };
      if (seen.current.times < 2) return;
      if (code === last.current.code && now - last.current.at < 2500) return;
      last.current = { code, at: now };
      navigator.vibrate?.(40);
      handler.current(code);
    };

    (async () => {
      try {
        const el = video.current;
        if (!el) return;
        if (window.BarcodeDetector) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
          if (stopped) return;
          el.srcObject = stream;
          await el.play();
          const supported = (await window.BarcodeDetector.getSupportedFormats?.()) ?? null;
          const formats = supported ? FORMATS.filter((f) => supported.includes(f)) : FORMATS;
          const detector = new window.BarcodeDetector(formats.length ? { formats } : undefined);
          setState('on');
          const tick = async () => {
            if (stopped) return;
            try {
              const found = await detector.detect(el);
              if (found[0]?.rawValue) emit(found[0].rawValue);
            } catch {
              // A frame that can't be read isn't an error.
            }
            timer = window.setTimeout(tick, 180);
          };
          void tick();
        } else {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')]);
          const reader = new BrowserMultiFormatReader(new Map([[DecodeHintType.POSSIBLE_FORMATS, [
            BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX,
          ]]]));
          const controls = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } }, audio: false }, el, (result) => {
            if (result) emit(result.getText());
          });
          zxingStop = () => controls.stop();
          if (stopped) zxingStop();
          else setState('on');
        }
      } catch (err) {
        const name = (err as { name?: string }).name;
        setError(name === 'NotAllowedError' ? 'Camera access was refused. Allow it in your browser settings, or type the code instead.' : name === 'NotFoundError' ? 'No camera was found. Type the code instead, or use a USB scanner.' : "The camera didn't start. Type the code instead.");
        setState('error');
      }
    })();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      zxingStop?.();
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [active, video]);

  return { state, error };
}

/**
 * A product barcode (EAN or UPC digits) in a photo, or null if there isn't one
 * this phone can read. Reads on the phone, so it costs nothing and never guesses a digit.
 */
export async function readBarcode(photo: Blob): Promise<string | null> {
  const product = (code: string | undefined) => (code && /^\d{8,14}$/.test(code) ? code : null);
  try {
    if (window.BarcodeDetector) {
      const bitmap = await createImageBitmap(photo);
      try {
        const found = await new window.BarcodeDetector().detect(bitmap);
        for (const f of found) if (product(f.rawValue)) return f.rawValue;
        return null;
      } finally {
        bitmap.close();
      }
    }
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const url = URL.createObjectURL(photo);
    try {
      return product((await new BrowserMultiFormatReader().decodeFromImageUrl(url)).getText());
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // No barcode in view, or this browser can't read photos for them.
    return null;
  }
}
