/**
 * Battery linking: battery products (AA, 9V, CR2032…) linked to the Home
 * Assistant devices that use them.
 *
 * The Home Assistant integration sends the list of devices with a battery
 * (and their level) and says when one runs low. This module answers with
 * what to do: swap in a charged spare, charge some flat ones, use a spare
 * from the drawer, or (when there are none) put the battery on the shopping
 * list. Larder itself knows nothing about Home Assistant: a device is just an
 * id, a name and a level, so any other system could send the same thing.
 */
import { z } from 'zod';
import { amount, defineModule, LarderError, ValidationError, type CoreApi, type ProductSummary } from '@larder/core';

export const Device = z.object({
  /** The device's id in Home Assistant (or whatever sent it). */
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  area: z.string().max(120).nullable().default(null),
  /** Battery level in %, if the device reports one. */
  level: z.number().min(0).max(100).nullable().default(null),
  low: z.boolean().default(false),
  /** Battery type and count, when known (for example from the Battery Notes integration). */
  batteryType: z.string().max(40).nullable().default(null),
  batteryQuantity: z.number().int().min(1).max(50).nullable().default(null),
  updatedAt: z.string().nullable().default(null),
}).meta({ id: 'BatteryDevice' });
export type Device = z.infer<typeof Device>;

export const Advice = z.object({
  deviceId: z.string(),
  device: z.string(),
  /**
   * swap: a charged rechargeable is ready. charge: only flat ones, charge some.
   * spare: a new battery is in stock. buy: none left, now on the shopping list.
   * on_the_way: none left but some are expected. unlinked: no battery type linked yet.
   */
  kind: z.enum(['swap', 'charge', 'spare', 'buy', 'on_the_way', 'unlinked']),
  productId: z.string().nullable(),
  battery: z.string().nullable(),
  /** Where the spares are. */
  place: z.string().nullable(),
  message: z.string(),
}).meta({ id: 'BatteryAdvice' });
export type Advice = z.infer<typeof Advice>;

const DeviceView = Device.extend({ batteries: z.array(z.object({ id: z.string(), name: z.string() })) });

/** What to do about a device's battery, given the battery product linked to it. */
export function adviceFor(device: Device, battery: ProductSummary | null): Omit<Advice, 'deviceId' | 'device'> {
  if (!battery) {
    return { kind: 'unlinked', productId: null, battery: null, place: null, message: `${device.name} needs a new battery. Link its battery type in Larder to see if there's a spare.` };
  }
  const p = battery.product;
  const need = device.batteryQuantity ?? 1;
  // Batteries are usually counted as "each"; say "batteries" when talking about them.
  const needs = amount(need, p.unit === 'each' ? 'battery' : p.unit);
  const place = battery.places[0]?.path ?? null;
  const from = place ? ` from ${place}` : '';
  const base = { productId: p.id, battery: p.name, place };
  if (p.rechargeable) {
    const charged = battery.charged ?? 0;
    const flat = battery.flat ?? 0;
    if (charged >= need) return { ...base, kind: 'swap', message: `${device.name} needs ${needs}. Swap in charged ${p.name}${from} (${charged} charged).` };
    if (flat > 0) {
      const ready = charged ? `only ${charged} of the ${p.name} ${charged === 1 ? 'is' : 'are'} charged` : `none of the ${p.name} are charged`;
      return { ...base, kind: 'charge', message: `${device.name} needs ${needs}, but ${ready}. Charge some: ${flat} ${flat === 1 ? 'is' : 'are'} flat.` };
    }
  } else if (battery.inStock >= need) {
    return { ...base, kind: 'spare', message: `${device.name} needs ${needs}. There ${battery.inStock === 1 ? 'is a spare' : `are ${battery.inStock} spares`}${place ? ` in ${place}` : ''}.` };
  }
  if (battery.expected > 0) return { ...base, kind: 'on_the_way', message: `${device.name} needs ${needs}. None spare, but ${battery.expected} ${battery.expected === 1 ? 'is' : 'are'} on the way.` };
  return { ...base, kind: 'buy', message: `${device.name} needs ${needs} and there are none spare. ${p.name} ${p.name.endsWith('s') ? 'are' : 'is'} on the shopping list.` };
}

export default defineModule({
  id: 'batteries',
  name: 'Battery linking',
  description: 'Links battery types to Home Assistant devices, and says what to do when a device runs low: swap, charge or buy.',
  version: '1.0.0',
  setup(ctx) {
    const devices = ctx.collection<Device>('devices');
    const allDevices = async () => (await devices.list()).map((d) => d.data);
    const core: CoreApi = ctx.core;

    async function linkedBattery(deviceId: string): Promise<ProductSummary | null> {
      const all = await core.products.list();
      return all.find((s) => s.product.haDeviceIds.includes(deviceId)) ?? null;
    }

    async function advise(device: Device): Promise<Advice> {
      const battery = await linkedBattery(device.id);
      const a = adviceFor(device, battery);
      if (a.kind === 'buy' && battery && !battery.product.onShoppingList) await core.products.setOnList(battery.product.id, true);
      return Advice.parse({ deviceId: device.id, device: device.name, ...a });
    }

    async function findDevice(ref: string): Promise<Device> {
      const all = await allDevices();
      const q = ref.trim().toLowerCase();
      const byId = all.find((x) => x.id === ref);
      if (byId) return byId;
      const named = all.filter((x) => x.name.toLowerCase() === q);
      if (named.length === 1) return named[0]!;
      if (named.length > 1) {
        // Home Assistant often gives several devices the same default name.
        const which = named.map((d) => `${d.name}${d.area ? ` in ${d.area}` : ''} (${d.id})`);
        throw new LarderError(`More than one device is called "${ref}": ${which.join('; ')}. Use the device id.`, 409, 'ambiguous');
      }
      throw new ValidationError(`Larder hasn't heard of a device called "${ref}". The Home Assistant integration sends the list of battery devices.`);
    }

    async function view(): Promise<z.infer<typeof DeviceView>[]> {
      const [all, products] = await Promise.all([allDevices(), core.products.list()]);
      return all
        .map((d) => ({ ...d, batteries: products.filter((s) => s.product.haDeviceIds.includes(d.id)).map((s) => ({ id: s.product.id, name: s.product.name })) }))
        .sort((a, b) => Number(b.low) - Number(a.low) || a.name.localeCompare(b.name));
    }

    ctx.addRoute({
      method: 'PUT', path: '/devices', summary: 'Replace the list of devices with batteries (sent by the Home Assistant integration)',
      body: z.object({ devices: z.array(Device.omit({ updatedAt: true })) }),
      response: z.object({ count: z.number() }),
      async handler({ body }) {
        const now = core.now();
        const incoming = (body as { devices: Device[] }).devices.map((d) => Device.parse({ ...d, updatedAt: now }));
        const keep = new Set(incoming.map((d) => d.id));
        for (const old of await allDevices()) if (!keep.has(old.id)) await devices.remove(old.id);
        for (const d of incoming) await devices.put(d.id, d);
        return { count: incoming.length };
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/devices', summary: 'Devices with batteries, low ones first, with the battery types linked to them',
      response: z.array(DeviceView),
      handler: () => view(),
    });

    ctx.addRoute({
      method: 'POST', path: '/low', summary: 'A device\'s battery is low: what should be done?',
      description: 'Publishes `batteries.low` with the advice. Puts the battery on the shopping list when there are none spare.',
      body: z.object({ deviceId: z.string().min(1), level: z.number().min(0).max(100).nullable().optional() }),
      response: Advice,
      async handler({ body }) {
        const b = body as { deviceId: string; level?: number | null };
        const d = await findDevice(b.deviceId);
        const updated = { ...d, low: true, level: b.level ?? d.level, updatedAt: core.now() };
        await devices.put(d.id, updated);
        const advice = await advise(updated);
        ctx.publish('batteries.low', { ...advice, level: updated.level });
        return advice;
      },
    });

    ctx.addRoute({
      method: 'GET', path: '/advice/:deviceId', summary: 'What to do about a device\'s battery, without changing anything',
      params: z.object({ deviceId: z.string().min(1) }),
      response: Advice,
      async handler({ params }) {
        const d = await findDevice((params as { deviceId: string }).deviceId);
        return Advice.parse({ deviceId: d.id, device: d.name, ...adviceFor(d, await linkedBattery(d.id)) });
      },
    });

    async function replaced(device: string) {
      const d = await findDevice(device);
      const battery = await linkedBattery(d.id);
      if (!battery) throw new ValidationError(`Link a battery type to ${d.name} in Larder first.`);
      const need = d.batteryQuantity ?? 1;
      const s = await core.stock.use({ productId: battery.product.id, quantity: need, note: `Into ${d.name}` });
      await devices.put(d.id, { ...d, low: false, updatedAt: core.now() });
      const left = battery.product.rechargeable ? `${s.charged ?? 0} charged, ${s.flat ?? 0} flat` : `${amount(s.inStock, battery.product.unit)} left`;
      return { message: `${d.name}: ${amount(need, battery.product.unit)} replaced. ${battery.product.name}: ${left}.`, device: d.name, item: battery.product.name, in_stock: s.inStock };
    }

    const DeviceRef = z.string().min(1).max(120).describe('The device, by name or Home Assistant device id');
    ctx.addAction({
      id: 'batteries_replaced', name: 'Batteries replaced',
      description: 'New batteries went into a device: takes them out of stock (rechargeables count as flat until charged).',
      input: z.object({ device: DeviceRef }),
      run: ({ device }) => replaced(device),
    });

    ctx.addTool({
      name: 'battery_devices', title: 'Devices with batteries', readOnly: true,
      description: 'The devices Home Assistant says have batteries, low ones first, with their level, the battery type each takes, and for a low one what to do (swap in a charged one, charge some, use a spare, wait for a delivery, or buy). Give a device for just that one.',
      input: z.object({ device: DeviceRef.optional() }),
      async run({ device }) {
        if (device) {
          const d = await findDevice(device);
          const a = Advice.parse({ deviceId: d.id, device: d.name, ...adviceFor(d, await linkedBattery(d.id)) });
          return { text: `${d.name}${d.area ? ` (${d.area})` : ''}: battery ${d.level === null ? 'level not known' : `at ${d.level}%`}${d.low ? ', low' : ''}. ${a.message}`, data: a };
        }
        const list = await view();
        if (!list.length) return { text: 'Larder hasn\'t been sent any devices with batteries. The Home Assistant integration sends them.', data: { devices: [] } };
        const text = list.map((d) => `- ${d.name}${d.area ? ` (${d.area})` : ''}: ${d.level === null ? 'level not known' : `${d.level}%`}${d.low ? ', LOW' : ''}; takes ${d.batteries.length ? d.batteries.map((b) => b.name).join(' or ') : 'no battery type linked yet'}${d.batteryQuantity && d.batteryQuantity > 1 ? ` ×${d.batteryQuantity}` : ''}`).join('\n');
        return { text, data: { devices: list.map((d) => ({ device: d.name, id: d.id, area: d.area, level: d.level, low: d.low, battery: d.batteries.map((b) => b.name) })) } };
      },
    });

    ctx.addTool({
      name: 'batteries_replaced', title: 'Batteries replaced in a device',
      description: 'New batteries went into a device: takes them out of stock (rechargeables count as flat until charged) and clears its low flag.',
      input: z.object({ device: DeviceRef }),
      async run({ device }) {
        const { message, ...data } = await replaced(device);
        return { text: message, data };
      },
    });

    ctx.addTool({
      name: 'link_battery', title: 'Say which battery a device takes', destructive: true,
      description: 'Link a battery item (e.g. "AA batteries") to a device that takes it, so a low battery says swap, charge or buy. A device takes one battery type: linking another replaces it. unlink: true takes the link off.',
      input: z.object({
        device: DeviceRef,
        battery: z.string().min(1).max(200).describe('The battery item in Larder, e.g. "AA batteries"'),
        unlink: z.boolean().optional().describe('True to take this link off'),
      }),
      async run({ device, battery, unlink }) {
        const d = await findDevice(device);
        const product = await core.resolve.product(battery);
        if (unlink) {
          if (!product.haDeviceIds.includes(d.id)) throw new ValidationError(`${d.name} isn't linked to ${product.name}.`);
          await core.products.update(product.id, { haDeviceIds: product.haDeviceIds.filter((x) => x !== d.id) });
          return { text: `${d.name} is no longer linked to ${product.name}.`, data: { device: d.name, battery: null } };
        }
        for (const other of (await core.products.list()).filter((x) => x.product.id !== product.id && x.product.haDeviceIds.includes(d.id))) {
          await core.products.update(other.product.id, { haDeviceIds: other.product.haDeviceIds.filter((x) => x !== d.id) });
        }
        if (!product.haDeviceIds.includes(d.id)) await core.products.update(product.id, { haDeviceIds: [...product.haDeviceIds, d.id] });
        const a = Advice.parse({ deviceId: d.id, device: d.name, ...adviceFor(d, await linkedBattery(d.id)) });
        return { text: `${d.name} takes ${product.name}.${d.low ? ` It's low: ${a.message}` : ''}`, data: { device: d.name, battery: product.name } };
      },
    });

    ctx.addSensor({
      id: 'batteries_low', name: 'Batteries low', icon: 'mdi:battery-alert', unit: 'devices',
      description: 'Devices whose battery is low, with what to do about each.',
      async read() {
        const low = (await allDevices()).filter((d) => d.low);
        const advice = await Promise.all(low.map(async (d) => Advice.parse({ deviceId: d.id, device: d.name, ...adviceFor(d, await linkedBattery(d.id)) })));
        return { state: low.length, attributes: { devices: advice.slice(0, 25).map((a) => ({ device: a.device, battery: a.battery, advice: a.kind, message: a.message })) } };
      },
    });
  },
});
