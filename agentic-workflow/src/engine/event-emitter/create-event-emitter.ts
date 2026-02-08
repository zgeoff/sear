import type { EngineEvent } from '../../types.js';

export type EventHandler = (event: EngineEvent) => void;

export type Unsubscribe = () => void;

export type EventEmitter = {
  on(handler: EventHandler): Unsubscribe;
  emit(event: EngineEvent): void;
};

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
