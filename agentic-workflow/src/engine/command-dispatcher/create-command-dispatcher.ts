import { match } from 'ts-pattern';
import type { EngineCommand } from '../../types.ts';
import type { CommandDispatcher, CommandHandlers } from './types.ts';

export function createCommandDispatcher(handlers: CommandHandlers): CommandDispatcher {
  return {
    dispatch(command: EngineCommand): void {
      match(command)
        .with({ command: 'dispatchImplementor' }, (c) => handlers.dispatchImplementor(c))
        .with({ command: 'dispatchReviewer' }, (c) => handlers.dispatchReviewer(c))
        .with({ command: 'cancelAgent' }, (c) => handlers.cancelAgent(c))
        .with({ command: 'cancelPlanner' }, (c) => handlers.cancelPlanner(c))
        .with({ command: 'shutdown' }, (c) => handlers.shutdown(c))
        .exhaustive();
    },
  };
}
