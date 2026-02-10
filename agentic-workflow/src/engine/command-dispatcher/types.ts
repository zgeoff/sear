import type {
  CancelAgentCommand,
  CancelPlannerCommand,
  DispatchImplementorCommand,
  DispatchReviewerCommand,
  EngineCommand,
  ShutdownCommand,
} from '../../types.ts';

export interface CommandHandlers {
  dispatchImplementor: (command: DispatchImplementorCommand) => void | Promise<void>;
  dispatchReviewer: (command: DispatchReviewerCommand) => void | Promise<void>;
  cancelAgent: (command: CancelAgentCommand) => void | Promise<void>;
  cancelPlanner: (command: CancelPlannerCommand) => void | Promise<void>;
  shutdown: (command: ShutdownCommand) => void;
}

export interface CommandDispatcher {
  dispatch: (command: EngineCommand) => void;
}
