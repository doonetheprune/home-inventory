/**
 * Example household data (the one from the mock-ups), so you can try Larder
 * straight away. Uses only the public core API, like a module would.
 */
import { addDays, type CoreApi } from '@larder/core';

export async function seedDemo(core: CoreApi): Promise<number> {
  const today = core.today();
  const cats = Object.fromEntries((await core.categories.list()).map((c) => [c.name, c.id]));
  const shopIds: Record<string, string> = {};
  for (const name of ['Aldi', 'Tesco', 'Toolstation', 'Pets at Home']) {
    const existing = (await core.shops.list()).find((s) => s.name === name);
    shopIds[name] = existing?.id ?? (await core.shops.addPreset(name)).id;
  }

  const place = async (name: string, parentId: string | null = null, code: string | null = null) => (await core.places.create({ name, parentId, code })).id;
  const kitchen = await place('Kitchen');
  const fridge = await place('Fridge', kitchen);
  const pantry = await place('Pantry', kitchen, 'P3');
  const drawer = await place('Drawer', kitchen, 'K2');
  const sink = await place('Under sink', kitchen);
  const medicine = await place('Medicine box', kitchen);
  const utility = await place('Utility');
  const u1 = await place('Shelf 1', utility, 'U1');
  const u2 = await place('Shelf 2', utility, 'U2');
  const dogBin = await place('Dog food bin', utility);
  const hall = await place('Hall');
  const hallDrawer = await place('Drawer', hall, 'H1');
  const bathroom = await place('Bathroom');
  const cabinet = await place('Cabinet', bathroom, 'B1');
  const garage = await place('Garage');
  const freezer = await place('Chest freezer', garage);
  await place('Top drawer', freezer, 'CF-1');
  const cf2 = await place('Middle drawer', freezer, 'CF-2');
  await place('Bottom drawer', freezer, 'CF-3');
  const racking = await core.places.createGrid({ parentId: garage, name: 'Garage racking', prefix: 'G', rows: 4, columns: 6 });
  const g = (code: string) => racking.places.find((p) => p.code === code)!.id;
  const shed = await place('Shed');
  const shedShelves = await core.places.createGrid({ parentId: shed, name: 'Shed shelves', prefix: 'S', rows: 3, columns: 4 });
  const s23 = shedShelves.places.find((p) => p.code === 'S2-3')!.id;
  const shedFloor = await place('Floor', shed);
  const outside = await place('Outside');
  const oilTank = await place('Oil tank', outside);
  const study = await place('Study');
  const filing = await place('Filing box', study);
  const gardenRoom = await place('Garden room');

  let count = 0;
  const product = async (p: Parameters<CoreApi['products']['create']>[0], stock: Array<{ quantity: number; placeId?: string; expiresOn?: string | null }> = []) => {
    const created = await core.products.create(p);
    for (const s of stock) await core.stock.add({ productId: created.id, quantity: s.quantity, placeId: s.placeId ?? created.defaultPlaceId, expiresOn: s.expiresOn });
    count++;
    return created;
  };

  await product({ name: 'Baby spinach', aliases: ['spinach', 'salad'], categoryId: cats.Food, unit: 'bag', shelfLifeDays: 5, defaultPlaceId: fridge }, [{ quantity: 1, expiresOn: today }]);
  await product({ name: 'Chicken thighs', aliases: ['chicken'], categoryId: cats.Food, unit: 'kg', shelfLifeDays: 4, defaultPlaceId: fridge }, [{ quantity: 1, expiresOn: addDays(today, 1) }]);
  await product({ name: 'Semi-skimmed milk', aliases: ['milk'], categoryId: cats.Food, unit: 'bottle', shelfLifeDays: 7, minQuantity: 1, defaultPlaceId: fridge, preferredShopIds: [shopIds.Aldi!] }, [{ quantity: 2, expiresOn: addDays(today, 2) }]);
  await product({ name: 'Baked beans', aliases: ['beans', 'beanz'], categoryId: cats.Food, unit: 'tin', shelfLifeDays: 730, minQuantity: 4, defaultPlaceId: pantry }, [{ quantity: 6 }]);
  await product({ name: 'Frozen peas', aliases: ['peas'], categoryId: cats.Food, unit: 'kg', shelfLifeDays: 365, defaultPlaceId: cf2 }, [{ quantity: 1.6 }]);
  await product({ name: 'Bananas', categoryId: cats.Food, unit: 'bunch', shelfLifeDays: 5, minQuantity: 1, preferredShopIds: [shopIds.Aldi!], defaultPlaceId: kitchen });
  await product({ name: 'Free-range eggs', aliases: ['eggs'], categoryId: cats.Food, unit: 'egg', shelfLifeDays: 21, minQuantity: 6, preferredShopIds: [shopIds.Aldi!], defaultPlaceId: kitchen }, [{ quantity: 2 }]);
  await product({ name: 'Mature cheddar', aliases: ['cheese'], categoryId: cats.Food, unit: 'g', shelfLifeDays: 30, minQuantity: 200, preferredShopIds: [shopIds.Aldi!], defaultPlaceId: fridge }, [{ quantity: 100 }]);
  await product({ name: 'Oat milk', aliases: ['oatly'], categoryId: cats.Food, unit: 'carton', minQuantity: 3, preferredShopIds: [shopIds.Tesco!], defaultPlaceId: pantry }, [{ quantity: 1 }]);
  await product({ name: 'Fish fingers', categoryId: cats.Food, unit: 'pack', minQuantity: 1, preferredShopIds: [shopIds.Tesco!], defaultPlaceId: cf2 });

  const loo = await product(
    { name: 'Toilet roll', aliases: ['loo roll', 'toilet paper', 'bog roll'], categoryId: cats.Household, unit: 'roll', minQuantity: 9, defaultPlaceId: u2, notes: 'Kids get through these fast in winter. Aldi 24 pack is usually the best value.' },
    [{ quantity: 3 }, { quantity: 1, placeId: cabinet }],
  );
  await core.products.addVariant(loo.id, { name: 'Andrex Classic Clean, 9 rolls', barcodes: ['5029053038889'], shopCodes: [{ shopId: shopIds.Tesco!, code: '254331802' }] });
  await core.products.addVariant(loo.id, { name: 'Saxon Soft, 24 rolls', barcodes: ['4088600261401'] });
  await core.stock.expect({ productId: loo.id, quantity: 18, source: 'Tesco delivery', eta: addDays(today, 1) });
  await product({ name: 'Washing-up liquid', aliases: ['fairy', 'dish soap'], categoryId: cats.Household, unit: 'bottle', minQuantity: 1, defaultPlaceId: sink }, [{ quantity: 0.25 }]);
  await product({ name: 'Dishwasher tablets', aliases: ['dishwasher tabs'], categoryId: cats.Household, unit: 'tablet', minQuantity: 10, defaultPlaceId: sink }, [{ quantity: 38 }]);
  await product({ name: 'Kitchen roll', categoryId: cats.Household, unit: 'roll', minQuantity: 2, defaultPlaceId: u1 }, [{ quantity: 1 }]);
  await product({ name: 'Bin bags', categoryId: cats.Household, unit: 'bag', minQuantity: 10, defaultPlaceId: sink }, [{ quantity: 3 }]);
  await product({ name: 'Candles', aliases: ['tea lights'], categoryId: cats.Household, unit: 'candle', defaultPlaceId: drawer }, [{ quantity: 12 }]);
  const beansLoo = await product({ name: 'Head torch', aliases: ['headlamp'], categoryId: cats.Household, unit: 'each', defaultPlaceId: hallDrawer }, [{ quantity: 2 }]);
  void beansLoo;

  await product({ name: 'Dog food', aliases: ['dog biscuits', 'kibble', 'harringtons'], categoryId: cats.Pets, unit: 'kg', minQuantity: 4, preferredShopIds: [shopIds['Pets at Home']!], defaultPlaceId: dogBin, notes: 'Harringtons lamb & rice, 15 kg bag.' }, [{ quantity: 2 }]);
  await product({ name: 'Wormer tablets', aliases: ['worming', 'milbemax'], categoryId: cats.Medicine, unit: 'dose', defaultPlaceId: medicine, notes: 'Milbemax, large dog. Every 3 months.' }, [{ quantity: 1, expiresOn: addDays(today, 15) }]);

  const aa = await product({ name: 'AA batteries', aliases: ['double a', 'eneloop'], categoryId: cats.Batteries, rechargeable: true, minQuantity: 8, defaultPlaceId: hallDrawer }, [{ quantity: 10 }]);
  await core.stock.use({ productId: aa.id, quantity: 4 });
  await product({ name: 'AAA batteries', aliases: ['triple a'], categoryId: cats.Batteries, unit: 'battery', minQuantity: 8, defaultPlaceId: hallDrawer }, [{ quantity: 3 }]);

  const drill = await product({ name: 'Cordless drill', aliases: ['drill', 'driver', 'makita'], categoryId: cats['Tools & DIY'], defaultPlaceId: s23, notes: 'Makita 18 V. Charger is in the same box.' }, [{ quantity: 1 }]);
  await core.stock.move({ productId: drill.id, toPlaceId: kitchen });
  const lead = await product({ name: 'Extension lead', aliases: ['extension cable', 'lead'], categoryId: cats['Tools & DIY'], defaultPlaceId: g('G1-2'), notes: '10 m, 4 sockets.' }, [{ quantity: 1 }]);
  await core.stock.move({ productId: lead.id, toPlaceId: gardenRoom });
  await product({ name: 'Cable ties', categoryId: cats['Tools & DIY'], unit: 'pack', minQuantity: 1, defaultPlaceId: g('G3-1') });
  await product({ name: 'Camping stove', categoryId: cats['Tools & DIY'], defaultPlaceId: g('G2-4') }, [{ quantity: 1 }]);
  const gas = await product({ name: 'Camping gas', aliases: ['gas canister', 'butane', 'campingaz'], categoryId: cats.Fuel, unit: 'canister', minQuantity: 3, preferredShopIds: [shopIds.Toolstation!], defaultPlaceId: g('G2-4') }, [{ quantity: 1 }]);
  await core.products.addVariant(gas.id, { name: 'Campingaz CV 470', shopCodes: [{ shopId: shopIds.Toolstation!, code: '76043' }] });
  await product({ name: 'Heating oil', aliases: ['kerosene', 'oil'], categoryId: cats.Fuel, unit: 'L', minQuantity: 300, defaultPlaceId: oilTank, notes: '1,200 L tank. Order from the oil syndicate in spring.' }, [{ quantity: 620 }]);
  await product({ name: 'Petrol', aliases: ['unleaded'], categoryId: cats.Fuel, unit: 'L', defaultPlaceId: shedFloor, notes: 'For the mower.' }, [{ quantity: 5 }]);

  await product({ name: 'House insurance', aliases: ['home insurance', 'buildings', 'contents'], categoryId: cats.Renewals, shelfLifeDays: 365, defaultPlaceId: filing, notes: 'Aviva. Policy number in the filing box.' }, [{ quantity: 1, expiresOn: addDays(today, 18) }]);
  await product({ name: 'Car MOT', aliases: ['mot'], categoryId: cats.Renewals, shelfLifeDays: 365, defaultPlaceId: filing, notes: 'Skoda Octavia.' }, [{ quantity: 1, expiresOn: addDays(today, 98) }]);

  await product({ name: 'Power bank, 20,000 mAh', categoryId: cats.Batteries, wish: true, notes: 'For power cuts. Anker, about £25.' });
  await product({ name: 'Wind-up radio', categoryId: cats.Household, wish: true });
  await product({ name: 'Wet & dry vacuum', categoryId: cats['Tools & DIY'], wish: true, preferredShopIds: [shopIds.Toolstation!] });
  return count;
}
