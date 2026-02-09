import type { EngineEvent } from '../../types.ts';
import type { EventEmitter, EventHandler, Unsubscribe } from './types.ts';

export function createEventEmitter(): EventEmitter {
  const handlers = new Set<EventHandler>();

  return {
    on(handler: EventHandler): Unsubscribe {
      handlers.add(handler);
      return (): void => {
        handlers.delete(handler);
      };
    },

    emit(event: EngineEvent): void {
      for (const handler of handlers) {
        handler(event);
      }
    },
  };
}
