/**
 * Product ad photo (social-agent): the pure shapes shared by the command side and the handler: the
 * `requirements_snapshot` keys and the product-photo reference recorded there (no I/O, no DB).
 */
export const SOCIAL_AGENT_ID = 'social-agent';
/** `requirements_snapshot` keys the social-agent reads. */
export const PRODUCT_FACTS_KEY = 'product_facts';
export const PRODUCT_PHOTOS_KEY = 'product_photos';

/** One product photo as recorded in the task snapshot. */
export interface ProductPhotoRef {
  readonly fileId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly originalName: string;
}
