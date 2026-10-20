import type { PlatformModule } from './contract';
import { aiPlatformModule } from './ai';

/** The console consumes this registry; pages do not maintain their own module list. */
const registeredModules: readonly PlatformModule[] = Object.freeze([aiPlatformModule]);

export function listPlatformModules(): readonly PlatformModule[] {
  return registeredModules;
}

export function getPlatformModule(id: string): PlatformModule | undefined {
  return registeredModules.find((module) => module.id === id);
}
