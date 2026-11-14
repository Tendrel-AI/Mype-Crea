import type { PlatformModule } from './contract';

export interface AiModuleConfig {
  /** Frozen release in ai_shared_releases used by default for new organizations. */
  readonly sharedReleaseId: string;
}

export const aiPlatformModule: PlatformModule<AiModuleConfig> = Object.freeze({
  id: 'ai',
  name: 'Inteligencia artificial',
  description: 'Versiones compartidas de modelos y comportamiento de IA.',
  globalSettings: Object.freeze([
    { key: 'sharedReleaseId', label: 'Versión compartida', description: 'Release compartido e inmutable de IA.', schema: { type: 'string', format: 'uuid' } },
  ]),
  tenantSettings: Object.freeze([
    { key: 'version', label: 'Versión de la organización', description: 'Versión global asignada explícitamente a esta organización.', schema: { type: 'integer', minimum: 1 } },
  ]),
  permissions: Object.freeze(['platform.modules.ai.read', 'platform.modules.ai.rollout']),
  metrics: Object.freeze([
    { key: 'active_users', label: 'Usuarios activos', aggregation: 'distinct_count' as const },
    { key: 'new_conversations', label: 'Conversaciones nuevas', aggregation: 'count' as const },
    { key: 'provider_model_usage', label: 'Uso por proveedor y modelo', aggregation: 'sum' as const },
    { key: 'estimated_cost', label: 'Costo estimado', aggregation: 'sum' as const },
    { key: 'errors', label: 'Errores', aggregation: 'count' as const },
    { key: 'active_versions', label: 'Versiones activas', aggregation: 'distinct_count' as const },
  ]),
  activationActions: Object.freeze([
    { key: 'preview', label: 'Vista previa', description: 'Calcula el alcance y los resultados antes de aplicar.' },
    { key: 'apply', label: 'Aplicar versión', description: 'Actualiza la versión predeterminada o las organizaciones seleccionadas.' },
    { key: 'rollback', label: 'Revertir versión', description: 'Restaura una versión anterior para el alcance seleccionado.' },
  ]),
  validateConfig(value: unknown): AiModuleConfig {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('AI module config must be an object.');
    const sharedReleaseId = (value as Record<string, unknown>).sharedReleaseId;
    if (typeof sharedReleaseId !== 'string' || !isUuid(sharedReleaseId)) throw new Error('AI module config requires a valid sharedReleaseId.');
    return Object.freeze({ sharedReleaseId });
  },
});

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
