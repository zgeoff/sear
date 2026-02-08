import { useRef } from 'react';
import type { Engine } from '../types';
import { createEngineStore } from './store';
import type { CreateEngineStoreConfig } from './types';

export type UseEngineConfig = {
  engine: Engine;
  repository: string;
};

export function useEngine(config: UseEngineConfig) {
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
