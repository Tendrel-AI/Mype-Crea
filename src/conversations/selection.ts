/**
 * KAN-25: which conversation a signed-in user sees, and the list they can switch to.
 *
 * Server-only. This is THE selection logic (KAN-30 state recovery builds on it):
 * the home page and the conversation server actions all go through these
 * functions, never through their own queries. Every read is owner-scoped through
 * `repos(tenant, user)` (RLS + explicit tenant/owner predicates), so a foreign,
 * missing or malformed id produces one identical "not found" outcome.
 */
import { randomUUID } from 'node:crypto';
import { resolveIdentity, type ResolvedIdentity } from '../auth/resolve-identity';
import { repos } from '../repos';
import { buildDefaultRegistry } from '../core/orchestrator/bootstrap-registry';
import { getOrchestrator } from '../core/orchestrator/runtime';
import type { ConversationId, DeliverableStateView, UUID } from '../core/contracts';
import { clientDeliverableUrl } from '../core/deliverable-url';
import { IMPORTED_KEY, entityName, validateAttributes } from '../core/brand-catalog';
import { loggerFor } from '../services/logger';
import { renderWelcome, welcomeContextLine, WELCOME_FALLBACK_TEXT } from '../adapters/chat-welcome';
import { adoptImportedBrand } from './imported-identity';
import { conversationListLabel } from './label';
import { briefPanelFields, type BriefPanelField } from './brief-panel';

const log = loggerFor('conversations.selection');

export const CONVERSATION_NOT_FOUND_MESSAGE = 'No encontramos esta conversación.';
export const NEW_CONVERSATION_UNAVAILABLE_MESSAGE = 'No hay una configuración activa para iniciar una conversación nueva.';
export const NEW_CONVERSATION_FAILED_MESSAGE = 'No pudimos iniciar la conversación. Inténtalo de nuevo.';
export const CONVERSATIONS_UNAVAILABLE_MESSAGE = 'No pudimos cargar tus conversaciones. Inténtalo de nuevo.';

export const brandLimitMessage = (limit: number) =>
  `Llegaste al límite de ${limit} marcas de tu organización. Archiva una marca o pide a tu administrador que lo aumente.`;
export const productLimitMessage = (limit: number) =>
  `Esta marca llegó al límite de ${limit} productos. Pide a tu administrador que lo aumente.`;
export const BRAND_NOT_FOUND_MESSAGE = 'No encontramos esta marca.';
export const PRODUCT_NOT_FOUND_MESSAGE = 'No encontramos este producto.';
export const INVALID_FIELDS_MESSAGE = 'Revisa los campos marcados.';

export interface ProductListEntry {
  readonly productId: UUID;
  readonly name: string | null;
}

/** A brand in «Mis conversaciones»; `name` is null until the brief names the business. */
export interface BrandListEntry {
  readonly brandId: UUID;
  readonly name: string | null;
  readonly products: ReadonlyArray<ProductListEntry>;
}

/** KAN-87: the brand and product a conversation belongs to, for the chat header. Null brand = legacy conversation. */
export interface ConversationContext {
  readonly brandId: UUID | null;
  readonly brandName: string | null;
  readonly productId: UUID | null;
  readonly productName: string | null;
}

/** KAN-87: an uploaded logo/asset as the forms list it; `url` is the authorized route. */
export interface BrandFileView {
  readonly id: UUID;
  readonly kind: 'logo' | 'asset' | 'lab_report';
  readonly productId: UUID | null;
  readonly originalName: string;
  readonly byteSize: number;
  readonly url: string;
}

export interface ConversationListEntry {
  readonly conversationId: ConversationId;
  /** KAN-85: null for conversations created before brands existed. */
  readonly brandId: UUID | null;
  /** KAN-87: the product the conversation belongs to, when any. */
  readonly productId: UUID | null;
  /** «Café Andino · 24 oct» / «Nueva conversación · 24 oct». */
  readonly label: string;
  readonly lastActivityAt: string;
}

export interface ConversationHistory {
  readonly conversationId: ConversationId;
  /** KAN-87: brand/product of the conversation; null when it could not be read. */
  readonly context: ConversationContext | null;
  /** KAN-93: state-based opening message (never persisted); shown when the conversation has no turns yet. */
  readonly welcome: string;
  readonly turns: ReadonlyArray<{
    readonly requestId: UUID;
    readonly userMessage: string | null;
    readonly content: string | null;
    readonly stage: string;
    readonly failureCategory: string | null;
    readonly notices: ReadonlyArray<{ readonly code: string; readonly content: string | null }>;
    readonly createdAt: string;
  }>;
  readonly deliverables: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly contentUrl: string | null;
    readonly contentInline: Record<string, unknown> | null;
    /** Set on the approved candidate of its kind (KAN-28 Aprobar), else null. */
    readonly selectedAt: string | null;
    readonly createdAt: string;
  }>;
  /** The persisted brief, so a resumed conversation renders it on first paint. */
  readonly brief: ReadonlyArray<BriefPanelField>;
  /**
   * KAN-30: server-derived deliverable states (tasks in progress, failures,
   * candidates, approvals) on first paint. Read-only: deriving them never
   * dispatches. Empty when they could not be read; the client reloads them.
   */
  readonly states: ReadonlyArray<DeliverableStateView>;
}

export type OwnedConversationLoad =
  | { readonly state: 'loaded'; readonly history: ConversationHistory }
  | { readonly state: 'not_found' }
  | { readonly state: 'legacy_unversioned' };

export type NewOwnedConversation =
  | { readonly ok: true; readonly conversationId: ConversationId; readonly brandId: UUID; readonly productId: UUID | null; readonly context: ConversationContext; readonly welcome: string }
  | {
      readonly ok: false;
      readonly code: 'brand_limit_reached' | 'product_limit_reached' | 'brand_not_found' | 'product_not_found' | 'invalid_input' | 'configuration_unavailable';
      readonly message: string;
      readonly limit?: number;
      /** `invalid_input`: Spanish error per catalog key (`_form` for whole-object errors). */
      readonly fieldErrors?: Record<string, string>;
    };

/** What `/` shows. `redirect` keeps the selected id in the URL so a reload reopens it. */
export type HomeConversationResult =
  | { readonly kind: 'redirect'; readonly conversationId: ConversationId }
  /** KAN-87: the user has no conversation yet; the page offers «Crear marca» / «Ya tengo una marca». */
  | { readonly kind: 'empty'; readonly brands: ReadonlyArray<BrandListEntry> }
  | {
      readonly kind: 'open';
      readonly history: ConversationHistory;
      readonly conversations: ReadonlyArray<ConversationListEntry>;
      readonly brands: ReadonlyArray<BrandListEntry>;
    }
  | {
      readonly kind: 'not_found';
      readonly message: typeof CONVERSATION_NOT_FOUND_MESSAGE;
      readonly conversations: ReadonlyArray<ConversationListEntry>;
      readonly brands: ReadonlyArray<BrandListEntry>;
    }
  | { readonly kind: 'error'; readonly message: string };

/** Canonical RFC 4122 UUID (versions 1-8). Anything else never reaches SQL. */
export function isConversationId(value: unknown): value is ConversationId {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function repository(identity: ResolvedIdentity) {
  return repos(identity.tenant, identity.user);
}

/** The owner's latest pinned conversations (max 20) by last activity, labelled server-side. */
export async function listOwnedConversations(
  identity: ResolvedIdentity,
): Promise<ConversationListEntry[]> {
  const rows = await repository(identity).conversations.listRecent();
  return rows.map((row) => ({
    conversationId: row.conversationId,
    brandId: row.brandId ?? null,
    productId: row.productId ?? null,
    label: conversationListLabel(row),
    lastActivityAt: row.lastActivityAt,
  }));
}

/** The owner's active brands, named by the brand or by its newest conversation's business name. */
export async function listOwnedBrands(identity: ResolvedIdentity): Promise<BrandListEntry[]> {
  const owned = repository(identity);
  const [rows, products] = await Promise.all([owned.brands.listActive(), owned.products.listActive()]);
  return rows.map((row) => ({
    brandId: row.id,
    name: row.name,
    products: products.filter((p) => p.brandId === row.id).map((p) => ({ productId: p.id, name: p.name })),
  }));
}

/**
 * Load the owner's durable trace. Foreign and missing ids are both `not_found`.
 * Note: a conversation of an archived brand leaves the list but still opens by direct URL (not read-only).
 */
export async function loadOwnedConversation(
  identity: ResolvedIdentity,
  conversationId: ConversationId,
): Promise<OwnedConversationLoad> {
  const owned = repository(identity);
  const registry = buildDefaultRegistry();
  const pin = await owned.conversations.readPinnedConversation(conversationId, registry.getFieldSchemas());
  if (!pin) return { state: 'not_found' };
  if (pin.state !== 'pinned') return { state: 'legacy_unversioned' };
  const turns = await owned.aiTurns.listTurns(conversationId);
  const deliverables = await owned.deliverables.listByConversation(conversationId);
  const states = await deliverableStates(identity, conversationId);
  const context = (await owned.conversations.context(conversationId)) ?? null;
  return {
    state: 'loaded',
    history: {
      conversationId,
      context,
      welcome: await welcomeFor(conversationId, context),
      turns: await Promise.all(turns.map(async (turn) => ({
        requestId: turn.requestId,
        userMessage: turn.inputContent,
        content: turn.responseContent,
        stage: turn.stage,
        failureCategory: turn.failureCategory,
        notices: (await owned.aiTurns.listNotices(turn.id)).map(({ code, content }) => ({ code, content })),
        createdAt: turn.createdAt,
      }))),
      deliverables: deliverables.map((deliverable) => ({
        id: deliverable.id,
        kind: deliverable.kind,
        // A stored image is only ever exposed through the authorized asset route (KAN-52).
        contentUrl: clientDeliverableUrl({ ...deliverable, metadata: deliverable.artifactMetadata ?? deliverable.contentInline?.metadata }),
        contentInline: deliverable.contentInline,
        selectedAt: deliverable.selectedAt ?? null,
        createdAt: deliverable.createdAt,
      })),
      brief: briefPanelFields(pin.snapshot, { hasBrand: context !== null && context.brandId !== null, hasProduct: context?.productId != null }),
      states,
    },
  };
}

/** Same read as the panel's `loadDeliverableStatesAction`, for an already authorized owner. */
async function deliverableStates(identity: ResolvedIdentity, conversationId: ConversationId): Promise<ReadonlyArray<DeliverableStateView>> {
  try {
    const core = getOrchestrator();
    await core.startConversation(conversationId, identity.tenant.id as UUID, identity.user.id as UUID);
    return await core.getDeliverableStates(conversationId);
  } catch (error) {
    log.error({ conversationId, err: error }, 'selection.states_failed');
    return [];
  }
}

/**
 * KAN-93: the opening message from the planner's current plan. `peekNextDecision` never consumes queued
 * announcements. Opening a conversation must never fail because of it: any error falls back to a fixed text.
 */
async function welcomeFor(conversationId: ConversationId, context: ConversationContext | null): Promise<string> {
  try {
    const decisions = await getOrchestrator().peekNextDecision(conversationId);
    return renderWelcome(decisions, context, buildDefaultRegistry());
  } catch (error) {
    log.warn({ conversationId, err: error }, 'selection.welcome_failed');
    return [welcomeContextLine(context), WELCOME_FALLBACK_TEXT].filter(Boolean).join('\n\n');
  }
}

/** Start the orchestrator for a conversation that was just pinned. */
async function startPinned(identity: ResolvedIdentity, conversationId: ConversationId): Promise<void> {
  await getOrchestrator().startConversation(conversationId, identity.tenant.id as UUID, identity.user.id as UUID);
}

/** What the client may send: never the server-owned `imported` flag. */
export function stripServerFlags(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const { [IMPORTED_KEY]: _server, ...rest } = raw as Record<string, unknown>;
  return rest;
}

/** The refusal for invalid attributes: per-field errors, nothing written. */
export function invalidFields(errors: Record<string, string>) {
  return { ok: false, code: 'invalid_input', message: INVALID_FIELDS_MESSAGE, fieldErrors: errors } as const;
}

async function startedConversation(
  identity: ResolvedIdentity,
  conversationId: ConversationId,
  brandId: UUID,
  productId: UUID | null,
  pin: { state: string } | undefined,
): Promise<NewOwnedConversation> {
  if (pin?.state !== 'pinned') return { ok: false, code: 'configuration_unavailable', message: NEW_CONVERSATION_UNAVAILABLE_MESSAGE };
  await startPinned(identity, conversationId);
  const context = (await repository(identity).conversations.context(conversationId))
    ?? { brandId, brandName: null, productId, productName: null };
  return { ok: true, conversationId, brandId, productId, context, welcome: await welcomeFor(conversationId, context) };
}

/**
 * KAN-87 «Crear marca» / «Ya tengo una marca»: validate the typed attributes (server verdict), then
 * create the brand and its first conversation in one transaction (limit checked there) and start the
 * orchestrator. Invalid input or the brand limit creates nothing.
 */
export async function createOwnedBrand(
  identity: ResolvedIdentity,
  input: { readonly attributes: unknown; readonly imported?: boolean },
): Promise<NewOwnedConversation> {
  const verdict = validateAttributes('brand', stripServerFlags(input.attributes), { partial: false });
  if (!verdict.ok) return invalidFields(verdict.errors);
  const attributes = input.imported ? { ...verdict.values, [IMPORTED_KEY]: true } : verdict.values;
  const conversationId = randomUUID() as ConversationId;
  const created = await repository(identity).brands.create({
    name: entityName('brand', attributes),
    attributes,
    firstConversation: { conversationId, schemas: buildDefaultRegistry().getFieldSchemas() },
  });
  if (!created.ok) {
    return { ok: false, code: created.code, limit: created.limit, message: brandLimitMessage(created.limit) };
  }
  log.debug({ brandId: created.brandId, conversationId }, 'selection.brand_created');
  const started = await startedConversation(identity, conversationId, created.brandId, null, created.pin);
  // KAN-89: an imported brand brings its name and tagline; its logo is adopted when it is uploaded.
  if (started.ok && input.imported) await adoptImportedBrand(identity, conversationId, attributes);
  return started;
}

/** KAN-87 «Nuevo producto»: validate, then create the product and its first conversation in one transaction. */
export async function createOwnedProduct(
  identity: ResolvedIdentity,
  input: { readonly brandId: UUID; readonly attributes: unknown },
): Promise<NewOwnedConversation> {
  const verdict = validateAttributes('product', input.attributes, { partial: false });
  if (!verdict.ok) return invalidFields(verdict.errors);
  const conversationId = randomUUID() as ConversationId;
  const created = await repository(identity).products.create({
    brandId: input.brandId,
    name: entityName('product', verdict.values),
    attributes: verdict.values,
    firstConversation: { conversationId, schemas: buildDefaultRegistry().getFieldSchemas() },
  });
  if (!created.ok) {
    return created.code === 'brand_not_found'
      ? { ok: false, code: 'brand_not_found', message: BRAND_NOT_FOUND_MESSAGE }
      : { ok: false, code: created.code, limit: created.limit, message: productLimitMessage(created.limit) };
  }
  log.debug({ brandId: input.brandId, productId: created.product.id, conversationId }, 'selection.product_created');
  return startedConversation(identity, conversationId, input.brandId, created.product.id, created.pin);
}

/**
 * Create and durably pin a new conversation under one of the owner's active brands (and optionally
 * one of its products) before the UI opens SSE. Never touches the caller's other conversations.
 */
export async function createOwnedConversation(identity: ResolvedIdentity, brandId: UUID, productId?: UUID): Promise<NewOwnedConversation> {
  const conversationId = randomUUID() as ConversationId;
  const created = await repository(identity).brands.createConversation({
    brandId,
    productId,
    conversationId,
    schemas: buildDefaultRegistry().getFieldSchemas(),
  });
  if (!created.ok) {
    return created.code === 'brand_not_found'
      ? { ok: false, code: 'brand_not_found', message: BRAND_NOT_FOUND_MESSAGE }
      : { ok: false, code: 'product_not_found', message: PRODUCT_NOT_FOUND_MESSAGE };
  }
  return startedConversation(identity, conversationId, brandId, productId ?? null, created.pin);
}

/**
 * Decide what `/` shows for the signed-in user.
 * - No id: redirect to the most recent conversation by last activity; when the user has none
 *   (legacy unversioned rows never count) the result is `empty` and the page offers the brand forms
 *   (KAN-87: a brand needs its required fields, so none is auto-created).
 * - An id: open it when it is the caller's own pinned conversation. Foreign
 *   (other user or tenant), missing, malformed and legacy ids all return the
 *   same `not_found` value, with the caller's own list so they can move on.
 */
export async function resolveHomeConversation(requestedId: string | string[] | undefined): Promise<HomeConversationResult> {
  let identity: ResolvedIdentity;
  try {
    identity = await resolveIdentity();
  } catch {
    return { kind: 'error', message: NEW_CONVERSATION_FAILED_MESSAGE };
  }

  if (requestedId === undefined) {
    try {
      const [latest] = await repository(identity).conversations.listRecent(1);
      if (latest) return { kind: 'redirect', conversationId: latest.conversationId };
      return { kind: 'empty', brands: await listOwnedBrands(identity) };
    } catch {
      return { kind: 'error', message: CONVERSATIONS_UNAVAILABLE_MESSAGE };
    }
  }

  try {
    const load = isConversationId(requestedId)
      ? await loadOwnedConversation(identity, requestedId)
      : { state: 'not_found' as const };
    const [conversations, brands] = await Promise.all([listOwnedConversations(identity), listOwnedBrands(identity)]);
    if (load.state !== 'loaded') {
      return { kind: 'not_found', message: CONVERSATION_NOT_FOUND_MESSAGE, conversations, brands };
    }
    return { kind: 'open', history: load.history, conversations, brands };
  } catch {
    return { kind: 'error', message: 'No pudimos cargar esta conversación. Inténtalo de nuevo.' };
  }
}
