import type { AgentHandler } from '../../src/core/agent-types';

export const handler: AgentHandler<undefined> = async () => {
  throw new Error('social-agent handler not implemented in Phase A');
};
