import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Aedes } from 'aedes';
import mqtt from 'mqtt';
import { createCore } from '@larder/core';
import { createMemoryStorage } from '../../src/adapters/storage-memory';
import { createMemoryFileStore } from '../../src/adapters/files-memory';
import { createMemorySearchIndex } from '../../src/adapters/search-memory';
import { createMemoryEventBus } from '../../src/adapters/events-memory';
import mqttModule, { topicSlug } from './index';

/** The retained value of a topic, as a client connecting now gets it. */
async function retained(url: string, topic: string): Promise<string | undefined> {
  const late = await mqtt.connectAsync(url);
  let value: string | undefined;
  late.on('message', (_t, p) => (value = p.toString()));
  await late.subscribeAsync(topic);
  for (let i = 0; i < 50 && value === undefined; i++) await new Promise((r) => setTimeout(r, 20));
  await late.endAsync();
  return value;
}

describe('MQTT module', () => {
  let url: string;
  let broker: Awaited<ReturnType<typeof Aedes.createBroker>>;
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    broker = await Aedes.createBroker();
    server = createServer(broker.handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => broker.close(() => r()));
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('is off by default, then publishes status, stock, sensors and events', async () => {
    const core = await createCore(
      { storage: createMemoryStorage(), files: createMemoryFileStore(), search: createMemorySearchIndex(), events: createMemoryEventBus() },
      { modules: [mqttModule], env: { LARDER_MODULE_MQTT_URL: url, LARDER_MODULE_MQTT_TOPIC: 'house' } },
    );
    expect(core.modules.list().find((m) => m.id === 'mqtt')?.enabled).toBe(false);

    const listener = await mqtt.connectAsync(url);
    const seen = new Map<string, string>();
    listener.on('message', (topic, payload) => seen.set(topic, payload.toString()));
    await listener.subscribeAsync('house/#');
    const waitFor = async (topic: string) => {
      for (let i = 0; i < 100 && !seen.has(topic); i++) await new Promise((r) => setTimeout(r, 30));
      return seen.get(topic);
    };

    const loo = await core.products.create({ name: 'Toilet roll', unit: 'roll', minQuantity: 9 });
    await core.modules.setEnabled('mqtt', true);
    expect(await waitFor('house/status')).toBe('online');
    expect(JSON.parse((await waitFor('house/stock/toilet_roll'))!)).toMatchObject({ name: 'Toilet roll', in_stock: 0, low: true });

    await core.stock.add({ productId: loo.id, quantity: 12 });
    expect(JSON.parse((await waitFor('house/event/stock.changed'))!)).toMatchObject({ type: 'stock.changed', data: { name: 'Toilet roll', inStock: 12 } });
    expect(JSON.parse((await waitFor('house/event/stock.restocked'))!).data.low).toBe(false);
    // What a dashboard connecting now sees (retained). (The test broker, aedes, can skip live
    // delivery of a retained message sent right after another; Mosquitto doesn't.)
    expect(JSON.parse((await retained(url, 'house/stock/toilet_roll'))!)).toMatchObject({ in_stock: 12, low: false });
    seen.delete('house/sensor/low_stock');
    expect(JSON.parse((await waitFor('house/sensor/low_stock'))!)).toMatchObject({ state: 0 });

    // Renamed or removed items don't leave their old retained topic behind.
    await core.products.update(loo.id, { name: 'Loo roll' });
    expect(JSON.parse((await waitFor('house/stock/loo_roll'))!)).toMatchObject({ in_stock: 12 });
    expect(await retained(url, 'house/stock/toilet_roll')).toBeUndefined();
    await core.products.remove(loo.id);
    for (let i = 0; i < 50 && (await retained(url, 'house/stock/loo_roll')) !== undefined; i++) await new Promise((r) => setTimeout(r, 30));
    expect(await retained(url, 'house/stock/loo_roll')).toBeUndefined();

    await core.modules.setEnabled('mqtt', false);
    for (let i = 0; i < 100 && seen.get('house/status') !== 'offline'; i++) await new Promise((r) => setTimeout(r, 30));
    expect(seen.get('house/status')).toBe('offline');
    await listener.endAsync();
  });

  it('makes topic-safe names', () => {
    expect(topicSlug('Power bank, 20,000 mAh')).toBe('power_bank_20_000_mah');
    expect(topicSlug("Sainsbury's own beans")).toBe('sainsbury_s_own_beans');
    expect(topicSlug('###')).toBe('item');
  });
});
