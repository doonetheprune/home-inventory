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
  /** Whole pages, linked from More (and the desktop sidebar). */
  pages?: Array<{ path: string; title: string; icon?: string; component: ComponentType }>;
}

export function defineWebModule(m: WebModule): WebModule {
  return m;
}

export { api, ApiError } from '../api';
export { useAction, useToast, Stepper, Sheet, Seg, Switch, Pill, Loading, ErrorBox, ProductTile, PlaceSelect, usePlaces, useShops, useCategories } from '../ui';
export { Icon } from '../icons';
export { money, qty, num, plural, shortDate, longDate } from '../format';
export { useQuery, useQueryClient } from '@tanstack/react-query';
export type { ProductDetail, ProductSummary, ShoppingList, ShoppingItem, HouseholdSettings } from '@larder/core';
