/** Declarative contract implemented by modules exposed in the platform console. */
export interface PlatformModuleSetting {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface PlatformModuleMetric {
  readonly key: string;
  readonly label: string;
  readonly aggregation: 'count' | 'sum' | 'distinct_count';
}

export interface PlatformModuleActivationAction {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}

export interface PlatformModule<Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly globalSettings: readonly PlatformModuleSetting[];
  readonly tenantSettings: readonly PlatformModuleSetting[];
  readonly permissions: readonly string[];
  readonly metrics: readonly PlatformModuleMetric[];
  readonly activationActions: readonly PlatformModuleActivationAction[];
  validateConfig(value: unknown): Config;
}
