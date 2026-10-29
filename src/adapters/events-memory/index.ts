/** In-process event bus. A failing listener never breaks the code that published the event. */
import type { EventBus, LarderEvent } from '@larder/core';

export function createMemoryEventBus(onError: (err: unknown, event: LarderEvent) => void = () => {}): EventBus {
  const handlers = new Set<(e: LarderEvent) => void>();
  return {
    publish(event) {
      for (const h of handlers) {
        try {
          h(event);
        } catch (err) {
          onError(err, event);
        }
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
