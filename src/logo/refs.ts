/**
 * Logo references (D62): the pure shapes shared by the command side and the logo handler: the
 * `requirements_snapshot` key and the reference-image record kept there (no I/O, no DB).
 */
export const LOGO_AGENT_ID = 'logo-agent';
/** `requirements_snapshot` key the logo-agent reads for the owner's reference images. */
export const LOGO_REFERENCES_KEY = 'logo_references';

/** Reference images per brand (D62). */
export const MAX_LOGO_REFERENCES = 3;

/** One reference image as recorded in the task snapshot. */
export interface LogoReferenceRef {
  readonly fileId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly originalName: string;
}
