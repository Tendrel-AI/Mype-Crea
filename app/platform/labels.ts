const actionLabels: Readonly<Record<string, string>> = {
  'superadmin.bootstrap': 'Configuración inicial de administrador global',
  'superadmin.grant': 'Acceso global otorgado',
  'superadmin.revoke': 'Acceso global revocado',
  'organization.create.staged': 'Creación de organización iniciada',
  'organization.create': 'Organización creada',
  'organization.update': 'Organización actualizada',
  'organization.deactivate': 'Organización desactivada',
  'organization.reactivate': 'Organización reactivada',
  ai_shared_release_published: 'Versión compartida de IA publicada',
  module_version_created: 'Versión de módulo publicada',
  module_rollout_applied: 'Despliegue de módulo aplicado',
  module_default_applied: 'Versión predeterminada actualizada',
};

const scopeLabels: Readonly<Record<string, string>> = {
  organization: 'Organización',
  organization_operation: 'Operación de organización',
  platform_identity: 'Administrador global',
  module: 'Módulo',
  ai_shared_release: 'Versión compartida de IA',
};

const reasonLabels: Readonly<Record<string, string>> = {
  'Configured initial platform administrator': 'Administrador global inicial configurado',
};

export function platformActionLabel(action: string): string {
  return actionLabels[action] ?? 'Otra acción';
}

export function platformScopeLabel(scope: string): string {
  return scopeLabels[scope] ?? 'Plataforma';
}

export function platformReasonLabel(reason: string): string {
  return reasonLabels[reason] ?? reason;
}
