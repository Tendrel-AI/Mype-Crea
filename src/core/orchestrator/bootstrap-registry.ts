import { AgentRegistry, type AgentCard } from './agent-registry';
import { handler as logoHandler } from '../../../agents/logo-agent/handler';
import logoCard from '../../../agents/logo-agent/agent-card.json';
import { handler as nameHandler } from '../../../agents/name-agent/handler';
import nameCard from '../../../agents/name-agent/agent-card.json';
import { handler as taglineHandler } from '../../../agents/tagline-agent/handler';
import taglineCard from '../../../agents/tagline-agent/agent-card.json';

/**
 * Build the canonical AgentRegistry by registering every Agent Card under
 * /agents/ that has a working handler. The registry is the orchestrator's
 * only view of which agents exist; ordering and dispatch decisions are
 * derived from card requirements, not from the registration order here.
 *
 * Live: logo-agent, name-agent (KAN-31) and tagline-agent (KAN-32).
 * label-agent and social-agent are stubs that throw "not implemented" — registering them
 * is unsafe because the planner picks the lex-first ready agent, so e.g.
 * `label-agent` would beat `logo-agent` to dispatch the moment its required
 * fields happen to be filled, and the stub throw would surface to the user
 * as a silent failure (only visible in agent_tasks.error). Re-add a card to
 * this list as soon as its handler returns a real artifact.
 */
export function buildDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(logoCard as AgentCard, logoHandler, undefined);
  registry.register(nameCard as AgentCard, nameHandler, undefined);
  registry.register(taglineCard as AgentCard, taglineHandler, undefined);
  return registry;
}
