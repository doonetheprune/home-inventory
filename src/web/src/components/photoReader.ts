/**
 * Reading a photo of a pack with whatever AI a module offers (the AI module's
 * Claude or Gemini), so the scanner can name things without the core knowing
 * which AI it is.
 */
import { useQuery } from '@tanstack/react-query';
import type { LookupResult } from '@larder/core';
import { useEnabledWebModules } from '../modules';

/** What an AI read from a photo, in Larder's terms. */
export interface PhotoReading {
  /** False when it couldn't make out a product; the rest is its best guess. */
  readable: boolean;
  /** What to call it, with its variety, and its brand when that's what it is: "Twinings Sleep tea bags", "Semi-skimmed milk". */
  name: string;
  /** The plain kind of thing, e.g. "Herbal tea": finds an item the household already has for it. */
  kind?: string | null;
  /** Brand and pack, e.g. "Heinz Baked Beanz 415 g". */
  brand: string | null;
  /** What it's bought in, a key from the unit list: "box", "jar", "each", or g or ml for something bought loose. */
  boughtIn: string;
  /** Its pack size, as printed on the pack: 20 tea bags, 400 g. */
  packSize?: { amount: number; unit: string } | null;
  categoryId: string | null;
  shelfLifeDays: number | null;
  aliases: string[];
  /** A shop's own brand: `id` is null when Larder doesn't have the shop yet. */
  shop: { name: string; id: string | null; preset: boolean } | null;
  /** Which of these it guessed rather than read: the scanner marks them to check. */
  guessed: Array<'boughtIn' | 'packSize' | 'categoryId'>;
  /** Which AI read it, e.g. "Claude". */
  by: string;
  /** Web pages it looked at when the photo wasn't enough, by site name, e.g. "twinings.co.uk". */
  sources?: Array<{ name: string; url: string }>;
  /** Anything worth saying, e.g. that the first AI was out of credit. */
  notes: string[];
  /** The photo as it was sent (smaller than a camera's): the one to keep as the item's photo. */
  photo?: Blob;
}

export interface PhotoReader {
  /** Whether it's set up, which AI it'll ask first, and whether barcodes found online go to it too. */
  status(): Promise<{ ready: boolean; by: string | null; barcodes?: boolean }>;
  read(photo: Blob): Promise<PhotoReading>;
  /** Works out the same from what an online database found for a barcode. */
  describe?(found: LookupResult): Promise<PhotoReading>;
}

/**
 * The photo reader a switched-on module offers, once it's set up; null otherwise. `describe` is there
 * when barcodes found online go to the AI too.
 */
export function usePhotoReader(): { read: PhotoReader['read']; describe: PhotoReader['describe'] | null; by: string | null } | null {
  const mod = useEnabledWebModules().find((m) => m.photoReader);
  const status = useQuery({ queryKey: ['photo-reader', mod?.id ?? 'none'], queryFn: () => mod!.photoReader!.status(), enabled: !!mod });
  if (!mod?.photoReader || !status.data?.ready) return null;
  return { read: mod.photoReader.read, describe: status.data.barcodes && mod.photoReader.describe ? mod.photoReader.describe : null, by: status.data.by };
}
