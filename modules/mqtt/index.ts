/**
 * MQTT: publishes Larder's changes to an MQTT broker, for systems that
 * listen there (Node-RED, home automation without the Home Assistant
 * integration, dashboards). Off by default. Larder's own database stays the
 * source of truth, and the Home Assistant integration stays the main link
 * to Home Assistant; this is an extra feed.
 *
 * Topics (prefix "larder" unless set):
 *   larder/status            "online" / "offline" (retained; offline is the last will)
 *   larder/stock/<item>      each item's stock as JSON (retained; cleared when the item is renamed or removed)
 *   larder/sensor/<id>       every sensor (running low, use soon…) as JSON (retained)
 *   larder/event/<type>      every event, e.g. larder/event/stock.low (not retained)
 *
 * Settings: LARDER_MODULE_MQTT_URL (mqtt://host:1883), _USERNAME, _PASSWORD,
 * _TOPIC (prefix), _RETAIN (default true). As a Home Assistant add-on it
 * finds the Mosquitto broker add-on by itself.
 */
import mqtt, { type MqttClient } from 'mqtt';
import { defineModule, type LarderEvent, type ProductSummary } from '@larder/core';

/** "Toilet roll" → "toilet_roll", for topic names. */
export const topicSlug = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'item';

const SENSOR_DELAY_MS = 1500;

export default defineModule({
  id: 'mqtt',
  name: 'MQTT',
  description: 'Publishes stock changes, sensors and events to an MQTT broker. Off by default.',
  version: '1.0.0',
  defaultEnabled: false,
  setup(ctx) {
    const url = ctx.config.url;
    const prefix = (ctx.config.topic || 'larder').replace(/\/+$/, '');
    const retain = ctx.config.retain !== 'false';
    let client: MqttClient | null = null;
    let sensorTimer: ReturnType<typeof setTimeout> | null = null;

    const send = (topic: string, payload: unknown, keep = retain) => {
      client?.publish(`${prefix}/${topic}`, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain: keep, qos: 0 });
    };

    // Where each item's stock was last published, so the old topic of a renamed or
    // removed item can be cleared (an empty retained message removes it from the broker).
    const stockTopics = new Map<string, string>();
    const clearStock = (productId: string) => {
      const topic = stockTopics.get(productId);
      stockTopics.delete(productId);
      // Names that differ only in punctuation share a topic; keep it while another item uses it.
      if (topic && retain && ![...stockTopics.values()].includes(topic)) send(topic, '', true);
    };
    const sendStock = (d: { id: string; name: string; in_stock: number; expected: number; unit: string; low: boolean }) => {
      const topic = `stock/${topicSlug(d.name)}`;
      if (stockTopics.get(d.id) !== topic) clearStock(d.id);
      stockTopics.set(d.id, topic);
      send(topic, d);
    };
    const stockOf = (s: ProductSummary) => ({ id: s.product.id, name: s.product.name, in_stock: s.inStock, expected: s.expected, unit: s.product.unit, low: s.status.low });

    async function publishSensors() {
      sensorTimer = null;
      if (!client?.connected) return;
      const state = await ctx.core.automation.read();
      for (const [id, reading] of Object.entries(state)) send(`sensor/${id}`, reading);
    }
    const sensorsSoon = () => {
      if (!sensorTimer) sensorTimer = setTimeout(() => void publishSensors().catch((err: unknown) => ctx.log.warn('Sensor publish failed', { error: String(err) })), SENSOR_DELAY_MS);
    };

    async function publishAllStock() {
      for (const s of await ctx.core.products.list()) sendStock(stockOf(s));
    }

    function connect() {
      if (client || !ctx.isEnabled()) return;
      if (!url) {
        ctx.log.warn('MQTT is switched on but has no broker. Set LARDER_MODULE_MQTT_URL, e.g. mqtt://192.168.1.10:1883.');
        return;
      }
      client = mqtt.connect(url, {
        username: ctx.config.username || undefined,
        password: ctx.config.password || undefined,
        clientId: `larder-${Math.random().toString(16).slice(2, 10)}`,
        reconnectPeriod: 5000,
        will: { topic: `${prefix}/status`, payload: Buffer.from('offline'), retain: true, qos: 0 },
      });
      client.on('connect', () => {
        ctx.log.info(`Connected to MQTT at ${url}`);
        send('status', 'online', true);
        void publishAllStock().then(publishSensors).catch((err: unknown) => ctx.log.warn('First publish failed', { error: String(err) }));
      });
      client.on('error', (err) => ctx.log.warn('MQTT error', { error: err.message }));
    }

    function disconnect() {
      if (!client) return;
      const c = client;
      client = null;
      if (sensorTimer) clearTimeout(sensorTimer);
      sensorTimer = null;
      if (c.connected) c.publish(`${prefix}/status`, 'offline', { retain: true }, () => void c.endAsync());
      else void c.endAsync(true);
    }

    // Follow the module being switched on and off (events reach `ctx.on` only while it's on).
    ctx.core.events.subscribe((e) => {
      if (e.type === 'settings.changed') (ctx.isEnabled() ? connect : disconnect)();
    });
    connect();

    ctx.on('*', (e: LarderEvent) => {
      if (e.type.startsWith('search.') || !client) return;
      send(`event/${e.type}`, e, false);
      if (e.type === 'stock.changed') {
        const d = e.data as { productId: string; name: string; inStock: number; expected: number; unit: string; low: boolean };
        sendStock({ id: d.productId, name: d.name, in_stock: d.inStock, expected: d.expected, unit: d.unit, low: d.low });
      }
      const product = e.data as { id?: string; name?: string };
      if (e.type === 'product.deleted' && product.id) clearStock(product.id);
      // Renamed: move its stock to the new topic.
      if ((e.type === 'product.updated' || e.type === 'product.created') && product.id && product.name && stockTopics.get(product.id) !== `stock/${topicSlug(product.name)}`) {
        void ctx.core.products.summary(product.id).then((s) => sendStock(stockOf(s))).catch(() => undefined);
      }
      if (/^(stock|product|place|shop|category|settings|shopping|batteries)\./.test(e.type)) sensorsSoon();
    });
  },
});
