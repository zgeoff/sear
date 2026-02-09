import { render } from 'ink';
import type { Engine } from '../types.ts';
import { App } from './app.tsx';

export interface RenderAppConfig {
  engine: Engine;
  repository: string;
}

export interface RenderAppResult {
  waitUntilExit: () => Promise<void>;
}

export function renderApp(config: RenderAppConfig): RenderAppResult {
  const { waitUntilExit } = render(<App engine={config.engine} repository={config.repository} />);
  return { waitUntilExit };
}
