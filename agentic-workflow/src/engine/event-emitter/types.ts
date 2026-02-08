import type { EngineEvent } from '../../types.js';

export type EventHandler = (event: EngineEvent) => void;

export type Unsubscribe = () => void;

export type EventEmitter = {
  on(handler: EventHandler): Unsubscribe;
  emit(event: EngineEvent): void;
};
