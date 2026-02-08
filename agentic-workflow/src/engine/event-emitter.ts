import type { EngineEvent } from '../types.js';

type EventHandler = (event: EngineEvent) => void;

type Unsubscribe = () => void;

type EventEmitter = {
  on(handler: EventHandler): Unsubscribe;
  emit(event: EngineEvent): void;
};

function createEventEmitter(): EventEmitter {
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

export { createEventEmitter };
export type { EventEmitter, EventHandler, Unsubscribe };
