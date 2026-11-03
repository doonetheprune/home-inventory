/**
 * Taking photos with a live camera view (Add by photo), and turning photos
 * round. The barcode scanner has its own camera code, tuned for reading codes.
 */
import { useEffect, useState, type RefObject } from 'react';
import type { CameraState } from './useBarcodeScanner';

/** Shows the back camera in `video` while `active`, at up to 1920×1080 so small print stays readable. */
export function useCamera(video: RefObject<HTMLVideoElement | null>, active: boolean): { state: CameraState; error: string | null } {
  const [state, setState] = useState<CameraState>('off');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError(!window.isSecureContext
        ? 'The camera needs a secure (https) address: open Larder through Home Assistant, Nabu Casa or your own HTTPS address. Or upload a photo.'
        : "This browser can't use the camera. Upload a photo instead.");
      setState('error');
      return;
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    setState('starting');
    setError(null);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
        const el = video.current;
        if (stopped || !el) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        el.srcObject = stream;
        await el.play();
        if (!stopped) setState('on');
      } catch (err) {
        if (stopped) return;
        const name = (err as { name?: string }).name;
        setError(name === 'NotAllowedError' ? 'Camera access was refused. Allow it in your browser or app settings, or upload a photo.' : name === 'NotFoundError' ? 'No camera was found. Upload a photo instead.' : "The camera didn't start. Try again, or upload a photo.");
        setState('error');
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (video.current) video.current.srcObject = null;
    };
  }, [active, video]);

  return { state, error };
}

function jpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the photo."))), 'image/jpeg', 0.92));
}

/** What the camera sees right now, as a JPEG at the camera's full size (more than the preview shows). */
export function grabFrame(video: HTMLVideoElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return jpeg(canvas);
}

/** The photo turned a quarter turn clockwise (or anticlockwise), as a JPEG. */
export async function rotatePhoto(photo: Blob, direction: 'clockwise' | 'anticlockwise' = 'clockwise'): Promise<Blob> {
  const bitmap = await createImageBitmap(photo, { imageOrientation: 'from-image' });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.height;
    canvas.height = bitmap.width;
    const ctx = canvas.getContext('2d')!;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(direction === 'clockwise' ? Math.PI / 2 : -Math.PI / 2);
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    return await jpeg(canvas);
  } finally {
    bitmap.close();
  }
}
