/**
 * MYPES Platform — Core ID primitives
 * ====================================
 *
 * Primitive string aliases shared by every other contract slice. This is the
 * leaf of the contracts dependency graph; nothing here imports from elsewhere
 * in `src/core/contracts/`.
 *
 * See `../contracts.ts` for the barrel re-export and the file-level rules.
 */

/** ISO 8601 timestamp string. */
export type ISOTimestamp = string;

/** UUID v4 string. */
export type UUID = string;

/** Stable identifier for a registered sub-agent (e.g. "logo-agent"). */
export type AgentId = string;

/** Identifier for a named field defined in an Agent Card's requirements. */
export type FieldName = string;

/** Identifier for a running conversation (one per user session). */
export type ConversationId = UUID;

/** Identifier for a dispatched agent task. */
export type TaskId = UUID;

/** Identifier for a deliverable produced by a task. */
export type DeliverableId = UUID;

/** Identifier for the input adapter that produced a delta (e.g. "chat-es", "form-v1"). */
export type AdapterSource = string;
