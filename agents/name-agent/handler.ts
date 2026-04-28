import type { A2AMessage, A2ATaskResult, AgentHandler } from '../../src/core/agent-types';

/**
 * Phase A: pure echo. Real OpenRouter integration lands in Phase B once
 * adapters and the DB-backed deliverables repo exist. The handler is
 * deliberately dependency-free so it can run in tests without env vars.
 */
export const handler: AgentHandler<undefined> = async (
  message: A2AMessage,
): Promise<A2ATaskResult> => {
  const businessName = message.requirements.business_name;
  const businessProfile = message.requirements.business_profile;

  return {
    status: 'completed',
    taskId: message.taskId,
    artifacts: [
      {
        kind: 'business_name',
        inline: {
          value: businessName,
          profile: businessProfile,
        },
      },
    ],
    completedAt: new Date().toISOString(),
  };
};
