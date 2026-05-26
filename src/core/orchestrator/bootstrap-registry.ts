import { AgentRegistry, type AgentCard } from './agent-registry';
import { handler as logoHandler } from '../../../agents/logo-agent/handler';
import logoCard from '../../../agents/logo-agent/agent-card.json';

/**
 * Build the canonical AgentRegistry by registering every Agent Card under
 * /agents/ that has a working handler. The registry is the orchestrator's
 * only view of which agents exist; ordering and dispatch decisions are
 * derived from card requirements, not from the registration order here.
 *
 * Phase A: only logo-agent has a real handler. tagline-agent, label-agent,
 * and social-agent are stubs that throw "not implemented" — registering them
 * is unsafe because the planner picks the lex-first ready agent, so e.g.
 * `label-agent` would beat `logo-agent` to dispatch the moment its required
 * fields happen to be filled, and the stub throw would surface to the user
 * as a silent failure (only visible in agent_tasks.error). Re-add a card to
 * this list as soon as its handler returns a real artifact.
 */
export function buildDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(logoCard as AgentCard, logoHandler, undefined);
  return registry;
}
