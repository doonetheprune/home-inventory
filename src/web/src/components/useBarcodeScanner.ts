/**
 * Reads barcodes and QR codes from the phone camera. Uses the browser's
 * built-in BarcodeDetector where there is one (Chrome on Android) and the
 * ZXing library elsewhere (iPhone Safari, Firefox). Cameras need HTTPS.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
declare global {
  interface Window {
    BarcodeDetector?: { new (opts?: { formats?: string[] }): Detector; getSupportedFormats?(): Promise<string[]> };
  }
}

export type CameraState = 'off' | 'starting' | 'on' | 'error';

export function cameraProblem(): string | null {
  if (!window.isSecureContext) return 'Camera scanning needs a secure (https) address. Open Larder through Home Assistant, Nabu Casa, Tailscale or your own HTTPS address, or use a USB scanner or type the code.';
  if (!navigator.mediaDevices?.getUserMedia) return "This browser can't use the camera. Type the code instead, or use a USB scanner.";
  return null;
}

export function useBarcodeScanner(video: RefObject<HTMLVideoElement | null>, active: boolean, onCode: (code: string) => void) {
  const [state, setState] = useState<CameraState>('off');
  const [error, setError] = useState<string | null>(null);
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const handler = useRef(onCode);
  handler.current = onCode;

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
      const now = Date.now();
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
          const formats = (await window.BarcodeDetector.getSupportedFormats?.()) ?? undefined;
          const detector = new window.BarcodeDetector(formats ? { formats } : undefined);
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
          const { BrowserMultiFormatReader } = await import('@zxing/browser');
          const reader = new BrowserMultiFormatReader();
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
