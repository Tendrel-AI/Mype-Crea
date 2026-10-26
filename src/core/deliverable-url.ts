/**
 * The one rule that turns a stored deliverable into the URL a client may see (KAN-52).
 *
 * A deliverable whose image was copied into the private bucket (`storageKey` set) is only ever
 * exposed as `/api/assets/<deliverableId>`: the route authorizes the caller and redirects to a
 * short-lived presigned URL. Neither the provider URL (kept in `contentUrl` for provenance) nor a
 * presigned URL may reach state, events or the outbox. Rows without a key (older rows, local dev
 * without a bucket) keep their `contentUrl`.
 *
 * Every place that hands a deliverable URL to a client goes through `clientDeliverableUrl`:
 * the reload and export actions, the deliverable workflow views, and the live and rebuilt
 * `task_completed` notices. Pure.
 */

export const ASSET_ROUTE_PREFIX = '/api/assets/';

export function assetRoutePath(deliverableId: string): string {
  return `${ASSET_ROUTE_PREFIX}${deliverableId}`;
}

export function clientDeliverableUrl(deliverable: {
  readonly id: string;
  readonly contentUrl: string | null;
  readonly storageKey?: string | null;
}): string | null {
  return deliverable.storageKey ? assetRoutePath(deliverable.id) : deliverable.contentUrl;
}
