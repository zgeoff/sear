import type {
  CancelAgentCommand,
  CancelPlannerCommand,
  DispatchImplementorCommand,
  DispatchReviewerCommand,
  EngineCommand,
  ShutdownCommand,
} from '../../types';

export type CommandHandlers = {
  dispatchImplementor(command: DispatchImplementorCommand): void;
  dispatchReviewer(command: DispatchReviewerCommand): void;
  cancelAgent(command: CancelAgentCommand): void;
  cancelPlanner(command: CancelPlannerCommand): void;
  shutdown(command: ShutdownCommand): void;
};

export type CommandDispatcher = {
  dispatch(command: EngineCommand): void;
};
