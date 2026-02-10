import { loadConfig } from './engine/config/load-config.ts';
import { createEngine } from './engine/create-engine.ts';
import { renderApp } from './tui/index.tsx';

async function main(): Promise<void> {
  const config = await loadConfig();
  const engine = createEngine(config);
  const { waitUntilExit } = renderApp({
    engine,
    repository: config.repository,
  });
  await waitUntilExit();
}

await main();
