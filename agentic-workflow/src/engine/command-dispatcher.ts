import { match } from 'ts-pattern';
import type {
  CancelAgentCommand,
  CancelPlannerCommand,
  DispatchImplementorCommand,
  DispatchReviewerCommand,
  EngineCommand,
  ShutdownCommand,
} from '../types.js';

type CommandHandlers = {
  dispatchImplementor(command: DispatchImplementorCommand): void;
  dispatchReviewer(command: DispatchReviewerCommand): void;
  cancelAgent(command: CancelAgentCommand): void;
  cancelPlanner(command: CancelPlannerCommand): void;
  shutdown(command: ShutdownCommand): void;
};

type CommandDispatcher = {
  dispatch(command: EngineCommand): void;
};

function createCommandDispatcher(handlers: CommandHandlers): CommandDispatcher {
  return {
    dispatch(command) {
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

export { createCommandDispatcher };
export type { CommandDispatcher, CommandHandlers };
