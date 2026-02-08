import type { EngineEvent } from '../../types';

export type EventHandler = (event: EngineEvent) => void;

export type Unsubscribe = () => void;

export type EventEmitter = {
  on(handler: EventHandler): Unsubscribe;
  emit(event: EngineEvent): void;
};
