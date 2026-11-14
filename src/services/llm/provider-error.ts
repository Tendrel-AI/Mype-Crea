export type ProviderFailureCategory =
  | 'invalid_credentials'
  | 'rate_limited'
  | 'model_unavailable'
  | 'provider_unavailable'
  | 'ambiguous'
  | 'invalid_response'
  | 'request_rejected';

/** Safe provider failure metadata. It deliberately excludes raw response bodies and credentials. */
export class ProviderCallError extends Error {
  constructor(
    readonly category: ProviderFailureCategory,
    readonly status?: number,
  ) {
    super(`Provider call failed: ${category}${status ? ` (${status})` : ''}.`);
    this.name = 'ProviderCallError';
  }
}

export function providerErrorFromStatus(status: number): ProviderCallError {
  if (status === 401 || status === 403) return new ProviderCallError('invalid_credentials', status);
  if (status === 429) return new ProviderCallError('rate_limited', status);
  if (status === 404) return new ProviderCallError('model_unavailable', status);
  if (status >= 500) return new ProviderCallError('provider_unavailable', status);
  return new ProviderCallError('request_rejected', status);
}

/** Classify only structured SDK status metadata; never inspect provider error prose. */
export function providerErrorFromUnknown(error: unknown): ProviderCallError {
  if (error instanceof ProviderCallError) return error;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status)) return providerErrorFromStatus(status);
  }
  // The provider may have accepted a request before a transport timeout/reset.
  return new ProviderCallError('ambiguous');
}
