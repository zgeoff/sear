import type { EventEmitter, EventHandler } from './types.js';

export function createEventEmitter(): EventEmitter {
  const handlers = new Set<EventHandler>();

  return {
    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    emit(event) {
      for (const handler of handlers) {
        handler(event);
      }
    },
  };
}
