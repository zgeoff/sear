import { loadConfig } from './engine/config/load-config';
import { createEngine } from './engine/create-engine';
import { renderApp } from './tui/index';

async function main() {
  const config = await loadConfig();
  const engine = createEngine(config);
  const { waitUntilExit } = renderApp({
    engine,
    repository: config.repository,
  });
  await waitUntilExit();
}

main();
