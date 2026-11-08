export class VersionConflictError extends Error {
  constructor(readonly key: string, readonly version: string) {
    super(`Version ${key}@${version} already registered with different content (bump the version)`);
    this.name = 'VersionConflictError';
  }
}

export class UnknownVersionError extends Error {
  constructor(readonly key: string, readonly version: string) {
    super(`Version ${key}@${version} is not registered`);
    this.name = 'UnknownVersionError';
  }
}

export class DuplicateRunError extends Error {
  constructor(readonly runId: string) {
    super(`Run ${runId} was already recorded`);
    this.name = 'DuplicateRunError';
  }
}

export class LedgerValidationError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`Invalid ${path}: ${reason}`);
    this.name = 'LedgerValidationError';
  }
}
