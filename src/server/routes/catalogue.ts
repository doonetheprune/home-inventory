import { z } from 'zod';
import {
  Category, CategoryCreate, CategoryPatch, GridCreate, Place, PlaceContents, PlaceCreate, PlaceNode, PlacePatch, PlaceRef, PlaceToSort, Shop, ShopCreate, ShopPatch, Unit, UnitCreate,
  type CoreApi,
} from '@larder/core';
import type { ZodApp } from '../app';
import { IdParams, Ok } from './common';

export function registerCatalogueRoutes(app: ZodApp, { core }: { core: CoreApi }) {
  /* Categories */
  {
    const tags = ['Categories'];
    app.get('/categories', { schema: { tags, summary: 'List categories', response: { 200: z.array(Category) } } }, () => core.categories.list());
    app.post('/categories', { schema: { tags, summary: 'Add a category', body: CategoryCreate, response: { 200: Category } } }, (r) => core.categories.create(r.body));
    app.patch('/categories/:id', { schema: { tags, summary: 'Change a category', params: IdParams, body: CategoryPatch, response: { 200: Category } } }, (r) => core.categories.update(r.params.id, r.body));
    app.delete('/categories/:id', { schema: { tags, summary: 'Remove an unused category', params: IdParams, response: { 200: Ok } } }, async (r) => {
      await core.categories.remove(r.params.id);
      return { ok: true as const };
    });
  }

  /* Units */
  {
    const tags = ['Units'];
    app.get('/units', { schema: { tags, summary: 'The unit list: Larder\'s own units, then the household\'s words', response: { 200: z.array(Unit) } } }, async () => [...(await core.units.list()).all]);
    app.post('/units', {
      schema: { tags, summary: 'Add a count word to the unit list', description: 'Its singular and plural, e.g. "sleeve" and "sleeves". A word Larder already has is refused.', body: UnitCreate, response: { 200: Unit } },
    }, (r) => core.units.add(r.body));
    app.delete('/units/:key', {
      schema: { tags, summary: 'Remove one of the household\'s words, once no item is bought in it, contains it or is used in it', params: z.object({ key: z.string().min(1).max(30) }), response: { 200: Ok } },
    }, async (r) => {
      await core.units.remove(r.params.key);
      return { ok: true as const };
    });
  }

  /* Shops */
  {
    const tags = ['Shops'];
    app.get('/shops', { schema: { tags, summary: 'List shops', response: { 200: z.array(Shop) } } }, () => core.shops.list());
    app.get('/shops/presets', { schema: { tags, summary: 'Common UK shops you can add in one go', response: { 200: z.array(z.object({ name: z.string(), sells: z.array(z.string()) })) } } }, () => core.shops.presets());
    app.post('/shops/presets', { schema: { tags, summary: 'Add a preset shop, e.g. Tesco', body: z.object({ name: z.string() }), response: { 200: Shop } } }, (r) => core.shops.addPreset(r.body.name));
    app.post('/shops', { schema: { tags, summary: 'Add a shop', body: ShopCreate, response: { 200: Shop } } }, (r) => core.shops.create(r.body));
    app.get('/shops/:id', { schema: { tags, summary: 'Get a shop', params: IdParams, response: { 200: Shop } } }, (r) => core.shops.get(r.params.id));
    app.patch('/shops/:id', { schema: { tags, summary: 'Change a shop (name, categories it sells)', params: IdParams, body: ShopPatch, response: { 200: Shop } } }, (r) => core.shops.update(r.params.id, r.body));
    app.delete('/shops/:id', { schema: { tags, summary: 'Remove a shop', params: IdParams, response: { 200: Ok } } }, async (r) => {
      await core.shops.remove(r.params.id);
      return { ok: true as const };
    });
  }

  /* Places */
  {
    const tags = ['Places'];
    app.get('/places', { schema: { tags, summary: 'Every place, with its full path', response: { 200: z.array(PlaceRef) } } }, () => core.places.list());
    app.get('/places/tree', { schema: { tags, summary: 'Places as a nested tree with item counts', response: { 200: z.array(PlaceNode) } } }, () => core.places.tree());
    app.post('/places', { schema: { tags, summary: 'Add a place', body: PlaceCreate, response: { 200: Place } } }, (r) => core.places.create(r.body));
    app.post('/places/grid', {
      schema: { tags, summary: 'Set up grid storage, e.g. 4 shelves × 6 boxes → G1-1 … G4-6', body: GridCreate, response: { 200: z.object({ container: Place, places: z.array(Place) }) } },
    }, (r) => core.places.createGrid(r.body));
    app.get('/places/to-sort', { schema: { tags, summary: 'Stock with no place yet ("To sort"), by item', response: { 200: PlaceToSort } } }, () => core.places.toSort());
    app.get('/places/:id', { schema: { tags, summary: "What's in a place (and what usually lives there)", params: IdParams, response: { 200: PlaceContents } } }, (r) => core.places.contents(r.params.id));
    app.patch('/places/:id', { schema: { tags, summary: 'Change a place', params: IdParams, body: PlacePatch, response: { 200: Place } } }, (r) => core.places.update(r.params.id, r.body));
    app.delete('/places/:id', { schema: { tags, summary: 'Remove an empty place', params: IdParams, response: { 200: Ok } } }, async (r) => {
      await core.places.remove(r.params.id);
      return { ok: true as const };
    });
  }
}
