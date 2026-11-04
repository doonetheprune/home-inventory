/** How Larder wakes a provider's machine (or the Larder Automations Mac) through Home Assistant, and puts it back to sleep. */
import { z } from 'zod';
import { LarderError, ValidationError, type ModuleContext } from '@larder/core';

const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

export const WakeSettings = z.object({
  /** A switch, button or script in Home Assistant that wakes the machine… */
  entityId: z.string().trim().max(200).regex(/^[a-z_]+\.[a-z0-9_]+$/, 'Use an entity id like switch.mac_mini or script.wake_mac').nullable().default(null),
  /** …or its MAC address, for Home Assistant's wake_on_lan.send_magic_packet. */
  mac: z.string().trim().regex(MAC, 'Use a MAC address like 4c:32:75:12:34:56').nullable().default(null),
  /** Where the magic packet goes, e.g. 192.168.1.255. Optional. */
  broadcastAddress: z.string().trim().max(60).nullable().default(null),
  /** How long to wait for it to answer after waking. */
  timeoutSeconds: z.number().int().min(10).max(900).default(180),
});
export type WakeSettings = z.infer<typeof WakeSettings>;

/** What Home Assistant does to wake (or sleep) the machine with an entity. */
export function actionFor(entityId: string, sleep: boolean): [string, string] {
  const domain = entityId.split('.')[0]!;
  switch (domain) {
    case 'switch': return ['switch', sleep ? 'turn_off' : 'turn_on'];
    case 'button': case 'input_button': return [domain, 'press'];
    case 'script': return ['script', 'turn_on'];
    case 'automation': return ['automation', 'trigger'];
    default: throw new ValidationError(`${entityId} isn't a switch, button, script or automation, so Larder can't use it to ${sleep ? 'put the machine to sleep' : 'wake the machine'}.`);
  }
}

/** Asks Home Assistant to wake the machine (or, with `sleep`, put it back to sleep). */
export async function wakeMachine(ctx: ModuleContext, r: { wake: WakeSettings | null; sleepEntityId: string | null }, sleep = false): Promise<void> {
  const ha = ctx.core.homeAssistant;
  const what = sleep ? 'put it to sleep' : 'wake it';
  if (!ha) throw new LarderError(`Larder can't reach Home Assistant to ${what}. As an add-on it always can; elsewhere set LARDER_HA_URL and LARDER_HA_TOKEN.`, 503, 'no_home_assistant');
  try {
    if (sleep) {
      const [domain, service] = actionFor(r.sleepEntityId!, true);
      await ha.callService(domain, service, { entity_id: r.sleepEntityId });
    } else if (r.wake?.entityId) {
      const [domain, service] = actionFor(r.wake.entityId, false);
      await ha.callService(domain, service, { entity_id: r.wake.entityId });
    } else if (r.wake?.mac) {
      await ha.callService('wake_on_lan', 'send_magic_packet', { mac: r.wake.mac, ...(r.wake.broadcastAddress ? { broadcast_address: r.wake.broadcastAddress } : {}) });
    }
  } catch (err) {
    if (err instanceof LarderError) throw err;
    const said = err instanceof Error ? err.message : String(err);
    const noWol = !sleep && !r.wake?.entityId && /wake_on_lan|not found/i.test(said);
    throw new LarderError(
      noWol
        ? `Home Assistant can't send a magic packet (${said}). Add the Wake on LAN integration in Home Assistant, or choose a switch or script to wake the machine instead.`
        : `Home Assistant couldn't ${what}: ${said}`,
      502, 'wake_failed',
    );
  }
}
