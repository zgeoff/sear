import { useRef } from 'react';
import type { StoreApi } from 'zustand';
import type { Engine } from '../types.ts';
import { createEngineStore } from './store.ts';
import type { CreateEngineStoreConfig, EngineStore } from './types.ts';

export interface UseEngineConfig {
  engine: Engine;
  repository: string;
}

export function useEngine(config: UseEngineConfig): StoreApi<EngineStore> {
  const storeRef = useRef<ReturnType<typeof createEngineStore> | null>(null);

  if (storeRef.current === null) {
    const storeConfig: CreateEngineStoreConfig = {
      engine: config.engine,
      repository: config.repository,
    };
    storeRef.current = createEngineStore(storeConfig);
  }

  return storeRef.current;
}
