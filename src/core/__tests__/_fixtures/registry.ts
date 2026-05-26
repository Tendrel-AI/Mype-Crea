/**
 * Shared registry fixtures for orchestrator + adapter tests.
 *
 * The production registry is built from cards under `/agents/`. Tests should
 * NOT depend on which production agents happen to exist — they exercise the
 * orchestrator's agent-agnostic behavior. This helper lets each test register
 * exactly the agents it needs.
 */

import { AgentRegistry, type AgentCard } from '../../orchestrator/agent-registry';
import type { A2AMessage, A2ATaskResult, AgentHandler } from '../../agent-types';
import type { TaskId, UUID } from '../../contracts';

/**
 * Echo handler: returns one inline text artifact per filled requirement.
 * Stand-in for any production handler in tests that just need dispatch
 * to "complete" the task.
 */
export const fixtureEchoHandler: AgentHandler<undefined> = async (
  message: A2AMessage,
): Promise<A2ATaskResult> => {
  const completedAt = new Date().toISOString();
  return {
    status: 'completed',
    taskId: message.taskId,
    artifacts: Object.entries(message.requirements).map(([name, value]) => ({
      kind: 'text',
      inline: { name, value },
      metadata: { source: 'fixture-echo' },
    })),
    completedAt: completedAt as `${string}T${string}Z`,
  };
};

export interface FixtureCardOptions {
  readonly id: string;
  readonly required?: ReadonlyArray<{ readonly name: string; readonly promptHint?: string }>;
  readonly optional?: ReadonlyArray<{ readonly name: string; readonly promptHint?: string }>;
  readonly tabLabel?: string;
}

export function buildFixtureCard(opts: FixtureCardOptions): AgentCard {
  return {
    name: opts.id as `${string}-${string}` as unknown as AgentCard['name'],
    description: `fixture agent ${opts.id}`,
    version: '0.0.1',
    skills: [],
    'mypes:requirements': {
      required: (opts.required ?? []).map((f) => ({
        name: f.name,
        type: 'string',
        promptHint: f.promptHint ?? `enter ${f.name}`,
      })),
      optional: (opts.optional ?? []).map((f) => ({
        name: f.name,
        type: 'string',
        promptHint: f.promptHint ?? `enter ${f.name}`,
      })),
    },
    'mypes:ui': {
      tabLabel: opts.tabLabel ?? opts.id,
      tabIcon: 'circle',
      displayOrder: 1,
      outputPreview: 'inline',
    },
    supportedInterfaces: [{ protocol: 'local', module: `fixture/${opts.id}` }],
  };
}

/**
 * Build a registry with a single fixture agent that requires `business_name`
 * and `business_profile`. Mirrors the field shape used across the four
 * production cards so existing test assertions translate cleanly.
 */
export function buildSingleAgentFixtureRegistry(agentId = 'test-fixture-agent'): {
  readonly registry: AgentRegistry;
  readonly agentId: string;
} {
  const registry = new AgentRegistry();
  registry.register(
    buildFixtureCard({
      id: agentId,
      required: [
        { name: 'business_name', promptHint: '¿Cómo se llama el negocio?' },
        { name: 'business_profile', promptHint: 'Cuéntame qué hace el negocio.' },
      ],
      optional: [{ name: 'tone', promptHint: '¿Qué tono prefieres?' }],
    }),
    fixtureEchoHandler,
    undefined,
  );
  return { registry, agentId };
}

export function fakeTaskId(): TaskId {
  return crypto.randomUUID() as UUID as TaskId;
}
