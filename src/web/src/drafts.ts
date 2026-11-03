/**
 * Hand-over from a module (Add by photo, say) to the Add item page. Kept in
 * memory only: a reload starts the page afresh, and a photo never leaves the
 * phone until the item is saved.
 */
import { useNavigate } from 'react-router-dom';

export interface AddItemDraft {
  name: string;
  aliases?: string[];
  categoryId?: string | null;
  unit?: string;
  shelfLifeDays?: number | null;
  preferredShopIds?: string[];
  /** Saved as the item's brand (a variant) with the barcode and photo, e.g. "Heinz Baked Beanz 415 g". */
  brand?: string | null;
  barcode?: string | null;
  /** Becomes the item's photo when it's saved. */
  photo?: Blob | null;
  /** Where the details came from, kept on the brand, e.g. "claude". */
  source?: string;
  /** A line shown above the form, e.g. "Read from your photo by Claude. Check it before adding." */
  note?: string;
  /** A photo already in Larder's files (e.g. a shared page's picture), used when there's no `photo`. */
  photoFileId?: string | null;
  links?: string[];
  notes?: string;
  defaultPlaceId?: string | null;
  /** Called with the new item's id once it's saved (e.g. to take it out of Pending). */
  onSaved?: (productId: string) => Promise<unknown>;
}

const drafts = new Map<string, AddItemDraft>();

export function putDraft(draft: AddItemDraft): string {
  const key = Math.random().toString(36).slice(2, 10);
  drafts.set(key, draft);
  // Only the last few are worth keeping (the back button can return to them).
  while (drafts.size > 5) drafts.delete(drafts.keys().next().value!);
  return key;
}

export function takeDraft(key: string | null): AddItemDraft | null {
  return (key && drafts.get(key)) || null;
}

/** Opens Add item filled in with `draft`, for the person to check and save. */
export function useAddItem(): (draft: AddItemDraft, options?: { replace?: boolean }) => void {
  const navigate = useNavigate();
  return (draft, options) => navigate(`/add?draft=${putDraft(draft)}`, { replace: options?.replace });
}
