import { useRef } from 'react';
import type { StoreApi } from 'zustand';
import type { Engine } from '../types.ts';
import { createTUIStore } from './store.ts';
import type { CreateTUIStoreConfig, TUIStore } from './types.ts';

export interface UseEngineConfig {
  engine: Engine;
}

export function useEngine(config: UseEngineConfig): StoreApi<TUIStore> {
  const storeRef = useRef<ReturnType<typeof createTUIStore> | null>(null);

  if (storeRef.current === null) {
    const storeConfig: CreateTUIStoreConfig = {
      engine: config.engine,
    };
    storeRef.current = createTUIStore(storeConfig);
  }

  return storeRef.current;
}
