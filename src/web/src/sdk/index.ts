/**
 * The web SDK for modules. A module's web.tsx default-exports
 * `defineWebModule({...})` and may import only from here, React and its own files.
 */
import type { ComponentType } from 'react';
import type { ProductDetail, ShoppingList } from '@larder/core';

export interface WebModule {
  /** Must match the server module's id; the UI only shows while the module is on. */
  id: string;
  /** Panels shown on a product page. */
  productPanels?: Array<ComponentType<{ product: ProductDetail }>>;
  /** Panels shown beside a shop's shopping list. */
  shoppingPanels?: Array<ComponentType<{ list: ShoppingList }>>;
  /**
   * Whole pages at /m/<module id><path>. Paths can have parameters ("/:id", read with
   * useModuleParams). Pages without parameters (and not `hidden`) are linked from More and
   * the desktop sidebar, under Organise (default) or Print.
   */
  pages?: Array<{ path: string; title: string; icon?: string; component: ComponentType; section?: 'organise' | 'print'; subtitle?: string; hidden?: boolean }>;
}

export function defineWebModule(m: WebModule): WebModule {
  return m;
}

export { api, ApiError } from '../api';
export { useAction, useToast, Stepper, Sheet, Seg, Switch, Pill, Loading, ErrorBox, ProductTile, PlaceSelect, usePlaces, useShops, useCategories } from '../ui';
export { Icon } from '../icons';
export { QrCode } from './qr';
export { useModuleParams, PrintSetup } from './page';
export { Header, Empty } from '../ui';
export { money, qty, num, plural, shortDate, longDate } from '../format';
export { useQuery, useQueryClient } from '@tanstack/react-query';
export { Link, useNavigate } from 'react-router-dom';
export type { ProductDetail, ProductSummary, ShoppingList, ShoppingItem, HouseholdSettings } from '@larder/core';
