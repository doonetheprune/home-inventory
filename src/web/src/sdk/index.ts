/**
 * The web SDK for modules. A module's web.tsx default-exports
 * `defineWebModule({...})` and may import only from here, React and its own files.
 */
import type { ComponentType } from 'react';
import type { ProductDetail, Shop, ShoppingList } from '@larder/core';
import type { PhotoReader } from '../components/photoReader';
import type { SlotPanel } from './panels';

export interface WebModule {
  /** Must match the server module's id; the UI only shows while the module is on. */
  id: string;
  /** Panels shown on a product page. */
  productPanels?: Array<ComponentType<{ product: ProductDetail }>>;
  /** Panels shown beside a shop's shopping list. */
  shoppingPanels?: Array<ComponentType<{ list: ShoppingList }>>;
  /** Panels inside each shop's card on the Shops page. */
  shopPanels?: Array<ComponentType<{ shop: Shop }>>;
  /**
   * Whole pages at /m/<module id><path>. Paths can have parameters ("/:id", read with
   * useModuleParams). Pages without parameters (and not `hidden`) are linked from More and
   * the desktop sidebar, under Organise (default) or Print; "wishlist" puts it right after the Wish list.
   */
  pages?: Array<{ path: string; title: string; icon?: string; component: ComponentType; section?: 'organise' | 'print' | 'wishlist'; subtitle?: string; hidden?: boolean }>;
  /** Panels on other modules' pages, at the slots those pages offer (e.g. recipes on a scenario). */
  panels?: SlotPanel[];
  /**
   * More ways to add things, shown on Home beside Add by name and in the desktop sidebar.
   * `path` is one of this module's pages. `useShown` (a hook) can hide it, e.g. until set up.
   */
  addActions?: Array<{ path: string; title: string; subtitle: string; icon?: string; useShown?: () => boolean }>;
  /** Panels at the top of the Wish list (e.g. how many shared links are waiting in Pending). */
  wishListPanels?: Array<ComponentType>;
  /** Reads a photo of a pack (an AI): the scanner offers "Take photo" when one is set up. */
  photoReader?: PhotoReader;
  /** Sections in Settings, after Modules. `admin` says whether this person may change settings. */
  settingsPanels?: Array<ComponentType<{ admin: boolean }>>;
  /**
   * Shown while a saved copy is open (no connection). Set it only when everything the pages and
   * panels read is saved with ctx.addOfflinePaths, or they hide themselves when a read fails.
   * Changes always fail in a copy, with a message saying why.
   */
  offline?: boolean;
}

export function defineWebModule(m: WebModule): WebModule {
  return m;
}

export { api, ApiError } from '../api';
export { useAction, useToast, Stepper, Sheet, Seg, Switch, Pill, Loading, ErrorBox, ProductTile, PlaceSelect, usePlaces, useShops, useCategories } from '../ui';
export { Icon } from '../icons';
export { QrCode } from './qr';
export { useModuleParams, PrintSetup } from './page';
export { ModulePanels, useModuleEnabled, type SlotPanel } from './panels';
export { useAddItem, type AddItemDraft } from '../drafts';
export { readBarcode } from '../components/useBarcodeScanner';
export { useCamera, grabFrame, rotatePhoto } from '../components/camera';
export type { PhotoReader, PhotoReading } from '../components/photoReader';
export { Header, Empty } from '../ui';
export { ProductPicker } from '../components/ProductPicker';
export { money, qty, num, plural, shortDate, longDate } from '../format';
export { useUnits } from '../units';
export { useQuery, useQueryClient } from '@tanstack/react-query';
export { Link, useNavigate } from 'react-router-dom';
export type { ProductDetail, ProductSummary, Shop, ShoppingList, ShoppingItem, HouseholdSettings } from '@larder/core';
