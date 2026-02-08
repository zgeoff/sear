import { render } from 'ink';
import type { Engine } from '../types';
import { App } from './app';

export type RenderAppConfig = {
  engine: Engine;
  repository: string;
};

export function renderApp(config: RenderAppConfig) {
  const { waitUntilExit } = render(<App engine={config.engine} repository={config.repository} />);
  return { waitUntilExit };
}
