import { AgentRegistry, type AgentCard } from './agent-registry';
import { handler as logoHandler } from '../../../agents/logo-agent/handler';
import logoCard from '../../../agents/logo-agent/agent-card.json';
import { handler as nameHandler } from '../../../agents/name-agent/handler';
import nameCard from '../../../agents/name-agent/agent-card.json';
import { handler as taglineHandler } from '../../../agents/tagline-agent/handler';
import taglineCard from '../../../agents/tagline-agent/agent-card.json';
import { handler as labelHandler } from '../../../agents/label-agent/handler';
import labelCard from '../../../agents/label-agent/agent-card.json';
import { handler as socialHandler } from '../../../agents/social-agent/handler';
import socialCard from '../../../agents/social-agent/agent-card.json';

/**
 * Build the canonical AgentRegistry by registering every Agent Card under
 * /agents/ that has a working handler. The registry is the orchestrator's
 * only view of which agents exist; ordering and dispatch decisions are
 * derived from card requirements, not from the registration order here.
 *
 * Live: logo-agent, name-agent (KAN-31), tagline-agent (KAN-32) and label-agent (D32: deterministic,
 * it has no brief fields, so it never competes in the planner).
 * social-agent (product ad photo): its only required field is `ad_brief`, asked once per product chat.
 * Register a card only once its handler returns real artifacts: the planner picks the lex-first ready agent.
 */
export function buildDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(logoCard as AgentCard, logoHandler, undefined);
  registry.register(nameCard as AgentCard, nameHandler, undefined);
  registry.register(taglineCard as AgentCard, taglineHandler, undefined);
  registry.register(labelCard as AgentCard, labelHandler, undefined);
  registry.register(socialCard as AgentCard, socialHandler, undefined);
  return registry;
}
