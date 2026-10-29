/**
 * Names the shared data shapes so the OpenAPI spec references them
 * ("$ref": "#/components/schemas/ProductSummary") instead of repeating them.
 */
import { z } from 'zod';
import * as M from '@larder/core';

const NAMED: Array<[z.ZodType, string]> = [
  [M.Category, 'Category'], [M.Shop, 'Shop'], [M.Place, 'Place'], [M.Link, 'Link'], [M.Product, 'Product'], [M.ShopCode, 'ShopCode'],
  [M.Variant, 'Variant'], [M.ExpectedInfo, 'ExpectedInfo'], [M.StockEntry, 'StockEntry'], [M.Movement, 'Movement'],
  [M.ProductStatus, 'ProductStatus'], [M.PlaceRef, 'PlaceRef'], [M.ProductSummary, 'ProductSummary'], [M.StockEntryView, 'StockEntryView'],
  [M.ProductDetail, 'ProductDetail'], [M.PlaceNode, 'PlaceNode'], [M.PlaceContents, 'PlaceContents'], [M.ShoppingItem, 'ShoppingItem'],
  [M.ShoppingList, 'ShoppingList'], [M.ShoppingSummary, 'ShoppingSummary'], [M.Delivery, 'Delivery'], [M.Dashboard, 'Dashboard'],
  [M.SearchResult, 'SearchResult'], [M.SearchSectionResult, 'SearchSection'], [M.LookupResult, 'LookupResult'], [M.IdentifyResult, 'IdentifyResult'],
  [M.HouseholdSettings, 'HouseholdSettings'],
];

export function registerSchemas() {
  for (const [schema, id] of NAMED) if (!z.globalRegistry.has(schema)) z.globalRegistry.add(schema, { id });
}
