import { AgentRegistry, type AgentCard } from './agent-registry';
import { handler as nameHandler } from '../../../agents/name-agent/handler';
import { handler as logoHandler } from '../../../agents/logo-agent/handler';
import { handler as taglineHandler } from '../../../agents/tagline-agent/handler';
import { handler as labelHandler } from '../../../agents/label-agent/handler';
import { handler as socialHandler } from '../../../agents/social-agent/handler';
import nameCard from '../../../agents/name-agent/agent-card.json';
import logoCard from '../../../agents/logo-agent/agent-card.json';
import taglineCard from '../../../agents/tagline-agent/agent-card.json';
import labelCard from '../../../agents/label-agent/agent-card.json';
import socialCard from '../../../agents/social-agent/agent-card.json';

/**
 * Build the canonical-5 AgentRegistry. Phase A wires the 5 Agent Cards
 * defined under /agents/ to their handlers — name-agent has a real echo
 * handler, the rest throw "not implemented" until Phase B.
 */
export function buildDefaultRegistry(): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(nameCard as AgentCard, nameHandler, undefined);
  registry.register(logoCard as AgentCard, logoHandler, undefined);
  registry.register(taglineCard as AgentCard, taglineHandler, undefined);
  registry.register(labelCard as AgentCard, labelHandler, undefined);
  registry.register(socialCard as AgentCard, socialHandler, undefined);
  return registry;
}
