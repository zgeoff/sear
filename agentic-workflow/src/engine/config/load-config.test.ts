import { expect, test, vi } from 'vitest';
import { loadConfig } from './load-config';

test('it exits the process when the config file does not exist', async () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });

  await expect(
    loadConfig({
      configPath: '/nonexistent/agentic-workflow.config.ts',
      logError: () => {},
    }),
  ).rejects.toThrow('process.exit called');

  expect(exitSpy).toHaveBeenCalledWith(1);

  exitSpy.mockRestore();
});
