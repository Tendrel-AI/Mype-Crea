import type { AgentId, FieldName, TaskId, UUID } from './contracts';

export class InvalidDeltaError extends Error {
  readonly name = 'InvalidDeltaError';
  constructor(message: string, readonly details?: { agentId?: AgentId; fieldName?: FieldName }) {
    super(message);
  }
}

export class AgentNotRegisteredError extends Error {
  readonly name = 'AgentNotRegisteredError';
  constructor(readonly agentId: AgentId) {
    super(`Agent not registered: ${agentId}`);
  }
}

export class TaskNotFoundError extends Error {
  readonly name = 'TaskNotFoundError';
  constructor(readonly taskId: TaskId) {
    super(`Task not found: ${taskId}`);
  }
}

export class CrossTenantAccessError extends Error {
  readonly name = 'CrossTenantAccessError';
  constructor(readonly expectedTenantId: UUID, readonly actualTenantId: UUID) {
    super(`Cross-tenant access denied: expected ${expectedTenantId}, got ${actualTenantId}`);
  }
}
