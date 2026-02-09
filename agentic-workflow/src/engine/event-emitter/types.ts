import type { EngineEvent } from '../../types.ts';

export type EventHandler = (event: EngineEvent) => void;

export type Unsubscribe = () => void;

export interface EventEmitter {
  on: (handler: EventHandler) => Unsubscribe;
  emit: (event: EngineEvent) => void;
}
