import type { AgentHandler } from '../../src/core/agent-types';

export const handler: AgentHandler<undefined> = async (message) => ({
  status: 'failed',
  taskId: message.taskId,
  error: { kind: 'not_implemented', message: 'label-agent handler not implemented in Phase A' },
  completedAt: new Date().toISOString(),
});
