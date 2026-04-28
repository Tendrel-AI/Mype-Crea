import type { AgentHandler } from '../../src/core/agent-types';

export const handler: AgentHandler<undefined> = async () => {
  throw new Error('label-agent handler not implemented in Phase A');
};
