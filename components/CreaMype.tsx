'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './crea-mype/Sidebar';
import { type BrandAssets, type Message, type Step } from './crea-mype/types';
import { FormModal } from './crea-mype/FormModal';
import { BrandForm, brandFormTitle, type BrandFiles, type BrandFormMode, type BrandFormResult } from './crea-mype/BrandForm';
import { ProductForm, productFormTitle } from './crea-mype/ProductForm';
import type { FormResult } from './crea-mype/CatalogForm';
import { removeLabReport, uploadBrandFiles, uploadLabReports } from './crea-mype/brand-files-client';
import { LabelCard, labelCommandAfterUpload } from './crea-mype/label-card';
import { LAB_UPLOAD_WAIT_MESSAGE } from './crea-mype/lab-upload-copy';
import { ConversationMenu } from './crea-mype/ConversationMenu';
import { ChatPanel } from './crea-mype/ChatPanel';
import { Dashboard } from './crea-mype/Dashboard';
import { LandingPreview } from './crea-mype/LandingPreview';
import { DeliverableCommands, NAME_AVAILABILITY_NOTE, type DeliverableCommandRequest } from './crea-mype/DeliverableCommands';
import { BriefPanel } from './crea-mype/BriefPanel';
import { loadBriefAction, updateBriefFieldAction, type BriefPanelField } from '../app/actions/brief';
import { chatAction } from '../app/actions/chat';
import { exportConversationTraceAction, listConversationsAction } from '../app/actions/conversations';
import { archiveBrandAction, createBrandAction, createProductAction, getBrandAction, getProductAction, updateBrandAction, updateProductAction } from '../app/actions/brands';
import type { BrandFileView, BrandListEntry, ConversationContext, ConversationListEntry, NewOwnedConversation } from '../src/conversations/selection';
import { deliverableCommandAction, loadDeliverableStatesAction } from '../app/actions/deliverable-command';
import { loadBrandAssetsAction, type BrandAssetsResult } from '../app/actions/brand-assets';
import { BrandAssetsReadOnly } from './crea-mype/BrandAssetsReadOnly';
import { listLabReportNamesAction } from '../app/actions/lab-reports';
import { LABEL_AGENT_ID } from '../src/labeling/lab-report-refs';
import { deliverableFeedbackAction, loadDeliverableFeedbackAction } from '../app/actions/deliverable-feedback';
import type { FeedbackValue } from '../src/repos/deliverable-feedback';
import type { DeliverableStateView } from '../src/core/contracts';
import { CLIENT_NOTIFICATION_KINDS, parseNotification } from '../src/core/contracts/notifications';
import { developerFailureChatText } from './crea-mype/failure-copy';
import { LOGO_AGENT_ID, completedLogoUrl } from './crea-mype/live-logo';
import { liveConnectionLost, nextProcessingAgents } from './crea-mype/live-updates';

interface CreaMypeProps {
  userEmail: string;
  userName: string;
  initialConversationId?: string;
  initialTurns?: ReadonlyArray<{
    requestId: string;
    userMessage: string | null;
    content: string | null;
    stage: string;
    failureCategory: string | null;
    notices: ReadonlyArray<{ code: string; content: string | null }>;
  }>;
  initialDeliverables?: ReadonlyArray<{
    kind: string;
    contentUrl: string | null;
    contentInline: Record<string, unknown> | null;
    selectedAt?: string | null;
  }>;
  /** KAN-25: the persisted brief of a resumed conversation, shown before the client reloads it. */
  initialBrief?: ReadonlyArray<BriefPanelField>;
  /** KAN-30: server-derived deliverable states (tasks in progress, failures, candidates) on first paint. */
  initialStates?: ReadonlyArray<DeliverableStateView>;
  /** Optional validated-on-render typed v1 landing-page envelope. No live producer exists yet. */
  landingPageContent?: unknown;
  initialError?: string;
  /** KAN-25: the caller's latest conversations for «Mis conversaciones», labelled server-side. */
  initialConversations?: ReadonlyArray<ConversationListEntry>;
  /** KAN-85: the caller's active brands, to group «Mis conversaciones». */
  initialBrands?: ReadonlyArray<BrandListEntry>;
  /** KAN-87: brand/product of the open conversation, for the header line. */
  initialContext?: ConversationContext | null;
  /** KAN-93: server-rendered opening message for a conversation with no turns yet. */
  initialWelcome?: string;
  /** KAN-27: the terms gate could not be read; no brand can be created. */
  creationBlocked?: boolean;
  /** KAN-25: the requested id is foreign, missing or malformed (one identical outcome). */
  conversationNotFound?: boolean;
}

/** KAN-93: the opening message is composed by the server from the plan and stored once the chat has turns. */
const welcomeMessage = (text: string): Message => ({ id: 'welcome', role: 'model', text, isSystem: true });

const NAME_AGENT_ID = 'name-agent';
const TAGLINE_AGENT_ID = 'tagline-agent';

/** Approved logo first (KAN-28 Aprobar), else the newest candidate. */
function initialLogoUrl(deliverables: NonNullable<CreaMypeProps['initialDeliverables']>): string {
  const logos = deliverables.filter((item) => item.kind === 'logo' && item.contentUrl);
  return (logos.find((item) => item.selectedAt) ?? logos.at(-1))?.contentUrl ?? '';
}

/** Same preference over the server-derived state. */
function preferredLogoUrl(view: DeliverableStateView | undefined): string | null {
  if (!view) return null;
  const approved = view.candidates.find((c) => c.deliverableId === view.approvedDeliverableId);
  return (approved ?? view.candidates.at(-1))?.contentUrl ?? null;
}

const EMPTY_ASSETS: BrandAssets = {
  name: '',
  profile: '',
  logoUrl: '',
  labelUrl: '',
  landingPage: '',
  marketingPlan: '',
};

export default function CreaMype({ userEmail, userName, initialConversationId = '', initialTurns = [], initialDeliverables = [], initialBrief = [], initialStates = [], landingPageContent, initialError, initialConversations = [], initialBrands = [], initialContext = null, initialWelcome = '', creationBlocked = false, conversationNotFound = false }: CreaMypeProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'gallery' | 'landing'>('create');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [assets, setAssets] = useState<BrandAssets>(() => ({
    ...EMPTY_ASSETS,
    logoUrl: initialLogoUrl(initialDeliverables),
    typedLandingPage: landingPageContent,
  }));
  const [notFound, setNotFound] = useState(conversationNotFound);
  const [messages, setMessages] = useState<Message[]>(() => conversationNotFound || !initialConversationId ? [] : [
    ...(initialWelcome ? [welcomeMessage(initialWelcome)] : []),
    ...initialTurns.flatMap((turn) => [
        ...(turn.userMessage ? [{ id: `${turn.requestId}:user`, role: 'user' as const, text: turn.userMessage }] : []),
        ...(turn.content ? [{ id: `${turn.requestId}:assistant`, role: 'model' as const, text: turn.content }] : []),
        ...turn.notices.filter((notice) => notice.content).map((notice, noticeIndex) => ({
          id: `${turn.requestId}:notice:${noticeIndex}`, role: 'model' as const, text: notice.content!, isNotice: true,
        })),
      ]),
  ]);
  const incompleteTurn = [...initialTurns].reverse().find((turn) => turn.stage !== 'responded');
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // KAN-87: the open brand/product form (a modal), and the header context of the open conversation.
  type FormModalState =
    | { kind: 'brand'; mode: BrandFormMode; brandId?: string; initial?: Record<string, unknown>; files?: ReadonlyArray<BrandFileView> }
    | { kind: 'product'; mode: 'create' | 'edit'; brandId?: string; productId?: string; initial?: Record<string, unknown>; brandAttributes?: Record<string, unknown> };
  const [formModal, setFormModal] = useState<FormModalState | null>(null);
  const [context, setContext] = useState<ConversationContext | null>(initialContext);
  // A created brand whose files failed to upload: its conversation opens when the form is closed or the upload succeeds.
  const [pendingOpen, setPendingOpen] = useState<Extract<NewOwnedConversation, { ok: true }> | null>(null);
  // Set of agent ids that are currently processing (claimed but no artifact
  // delivered yet). Populated by `task_processing` SSE events from the worker
  // and cleared by `artifact` events. Drives the per-panel spinner.
  const [processingAgents, setProcessingAgents] = useState<Set<string>>(() => new Set());

  // Server-side conversations.id — generated once per session, regenerated on
  // "Nuevo". Threaded into chatAction so messages and llm_calls rows are
  // attributed to the right conversation row.
  const [conversationId, setConversationId] = useState<string>(initialConversationId);
  // Async results of a previous conversation must not land in the current one.
  const currentConversationRef = useRef(initialConversationId);
  const [retryTurn, setRetryTurn] = useState<{ requestId: string; userMessage: string } | null>(() =>
    incompleteTurn && ['reserved', 'extracted', 'effects_committed'].includes(incompleteTurn.stage) && incompleteTurn.userMessage
      ? { requestId: incompleteTurn.requestId, userMessage: incompleteTurn.userMessage }
      : null,
  );
  const [needsNewConversation, setNeedsNewConversation] = useState(() =>
    Boolean(incompleteTurn && ['effects_started', 'uncertain'].includes(incompleteTurn.stage)),
  );
  const [conversationError, setConversationError] = useState(initialError ?? '');
  // KAN-28: server-derived deliverable states. Buttons are rendered from
  // `allowedCommands`, but the server re-validates every command.
  const [deliverableStates, setDeliverableStates] = useState<ReadonlyArray<DeliverableStateView>>(initialStates);
  // KAN-30: the SSE stream is gone; the chat stays usable and a reload re-reads durable state.
  const [liveLost, setLiveLost] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState('');
  // The card whose command produced `commandError`; only that card shows it.
  const [commandErrorAgent, setCommandErrorAgent] = useState('');
  // F13: the owner's 👍 / 👎 by deliverable id (loaded from the server; updated optimistically).
  const [feedback, setFeedback] = useState<Readonly<Record<string, FeedbackValue>>>({});
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const logoView = deliverableStates.find((view) => view.agentId === LOGO_AGENT_ID);
  const nameView = deliverableStates.find((view) => view.agentId === NAME_AGENT_ID);
  const taglineView = deliverableStates.find((view) => view.agentId === TAGLINE_AGENT_ID);
  // D32: the label is a product deliverable; a brand conversation never shows it.
  const productId = context?.productId ?? null;
  const labelView = productId ? deliverableStates.find((view) => view.agentId === LABEL_AGENT_ID) : undefined;
  const [labReportNames, setLabReportNames] = useState<ReadonlyArray<{ id: string; name: string }>>([]);
  const [labUploading, setLabUploading] = useState(false);
  // D34: a product conversation shows the brand's approved assets read-only.
  const [brandAssets, setBrandAssets] = useState<Extract<BrandAssetsResult, { ok: true }> | null>(null);
  // KAN-26: the brief exactly as the server last returned it.
  const [briefFields, setBriefFields] = useState<ReadonlyArray<BriefPanelField>>(initialBrief);
  const [briefSaving, setBriefSaving] = useState<string | null>(null);
  const [briefError, setBriefError] = useState<{ field: string; message: string } | null>(null);

  const applyStates = useCallback((states: ReadonlyArray<DeliverableStateView>) => {
    setDeliverableStates(states);
    const url = preferredLogoUrl(states.find((view) => view.agentId === LOGO_AGENT_ID));
    if (url) setAssets((prev) => (prev.logoUrl === url ? prev : { ...prev, logoUrl: url }));
  }, []);

  const refreshStates = useCallback(async (forConversation: string) => {
    if (!forConversation) return;
    try {
      const result = await loadDeliverableStatesAction({ conversationId: forConversation });
      if (result.ok && currentConversationRef.current === forConversation) applyStates(result.states);
    } catch (error) {
      console.error('Failed to load deliverable states', error);
    }
  }, [applyStates]);

  /** Brief plus deliverable states, both read from the server. */
  const refreshBrief = useCallback(async (forConversation: string) => {
    if (!forConversation) return;
    try {
      const result = await loadBriefAction({ conversationId: forConversation });
      if (!result.ok || currentConversationRef.current !== forConversation) return;
      setBriefFields(result.fields);
      applyStates(result.states);
    } catch (error) {
      console.error('Failed to load the brief', error);
    }
  }, [applyStates]);

  const saveBriefField = async (fieldName: string, value: string): Promise<boolean> => {
    if (!conversationId || briefSaving) return false;
    setBriefSaving(fieldName);
    setBriefError(null);
    try {
      const result = await updateBriefFieldAction({ conversationId, fieldName, value });
      if (!result.ok) {
        setBriefError({ field: fieldName, message: result.message });
        return false;
      }
      setBriefFields(result.fields);
      applyStates(result.states);
      return true;
    } catch (error) {
      console.error('Brief update failed.', error);
      setBriefError({ field: fieldName, message: 'No pudimos confirmar el cambio. Revisa el dato antes de intentarlo de nuevo.' });
      await refreshBrief(conversationId);
      return false;
    } finally {
      setBriefSaving(null);
    }
  };

  // Step is derived from filled assets (logo arrives via SSE; the other
  // panels stay at "Pendiente" until their sub-agents land). The orchestrator
  // has no step concept — this is a UI affordance only.
  const step: Step = assets.marketingPlan
    ? 6
    : assets.typedLandingPage || assets.landingPage
      ? 5
      : assets.labelUrl
        ? 4
        : assets.logoUrl
          ? 3
          : 1;

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  useEffect(() => {
    void refreshBrief(conversationId);
  }, [conversationId, refreshBrief]);

  useEffect(() => {
    setFeedback({});
    if (!conversationId) return;
    let active = true; // a slower load of the previous conversation must not overwrite this one
    void loadDeliverableFeedbackAction({ conversationId })
      .then((result) => { if (active && result.ok) setFeedback(result.feedback); })
      .catch((error) => console.error('Failed to load deliverable feedback', error));
    return () => { active = false; };
  }, [conversationId]);

  const refreshLabReports = useCallback(async (forConversation: string) => {
    try {
      const result = await listLabReportNamesAction({ conversationId: forConversation });
      if (result.ok && currentConversationRef.current === forConversation) setLabReportNames(result.reports);
    } catch (error) {
      console.error('Failed to load lab reports', error);
    }
  }, []);

  useEffect(() => {
    setBrandAssets(null);
    if (!conversationId || !productId) return;
    void loadBrandAssetsAction({ conversationId })
      .then((result) => { if (result.ok && currentConversationRef.current === conversationId) setBrandAssets(result); })
      .catch((error) => console.error('Failed to load brand assets', error));
  }, [conversationId, productId]);

  useEffect(() => {
    setLabReportNames([]);
    if (conversationId && productId) void refreshLabReports(conversationId);
  }, [conversationId, productId, refreshLabReports]);

  // Subscribe to artifact events from the orchestrator. The SSE stream is
  // scoped to the current conversationId; resetting the conversation
  // (Nuevo button) closes the old EventSource and opens a fresh one.
  useEffect(() => {
    if (!conversationId) return;
    const url = `/api/agents/stream?conversationId=${conversationId}`;
    const source = new EventSource(url);
    let errorsSinceOpen = 0;
    source.addEventListener('open', () => {
      console.info('[SSE] connected', { conversationId, readyState: source.readyState });
      // Durable events are acked once for everyone: re-read what a dropped connection or another tab may have missed.
      void refreshStates(conversationId);
      errorsSinceOpen = 0;
      setLiveLost(false);
    });
    source.addEventListener('error', () => {
      errorsSinceOpen += 1;
      if (liveConnectionLost(source.readyState, errorsSinceOpen)) setLiveLost(true);
      // EventSource doesn't expose status codes; readyState tells us whether
      // the browser will retry (CONNECTING=0) or has given up (CLOSED=2).
      // CLOSED here means the server returned a non-2xx (e.g. 404 from the
      // SSE route) and the WHATWG spec forbids auto-reconnect on HTTP errors.
      const readyStateName =
        source.readyState === EventSource.CONNECTING
          ? 'CONNECTING (will retry)'
          : source.readyState === EventSource.CLOSED
            ? 'CLOSED (will not retry — likely an HTTP error from /api/agents/stream)'
            : 'OPEN';
      console.error('[SSE] connection error', {
        conversationId,
        url,
        readyState: source.readyState,
        readyStateName,
      });
    });
    // Every frame is a notification of the shared contract; the SSE event name
    // is its kind. One parser, one exhaustive switch.
    const onNotification = (raw: MessageEvent<string>) => {
      const parsed = parseNotification(raw.data, CLIENT_NOTIFICATION_KINDS);
      if (!parsed.ok) {
        console.error('[SSE] rejected notification', { reason: parsed.reason, detail: parsed.detail });
        return;
      }
      const event = parsed.notification;
      // A completion or a terminal failure clears the agent's spinner; shown deliverables stay.
      setProcessingAgents((prev) => nextProcessingAgents(prev, event));
      switch (event.kind) {
        case 'task_processing':
          break;
        case 'task_completed': {
          const imgUrl = completedLogoUrl(event);
          if (imgUrl) setAssets((prev) => ({ ...prev, logoUrl: imgUrl }));
          break;
        }
        case 'task_failed':
          // The server sends the technical detail only in developer mode (KAN-58);
          // otherwise the card alone shows the failed state and its recovery commands.
          if (event.detail) {
            const detail = event.detail;
            const id = `${event.taskId}:failure-detail`;
            setMessages((prev) => prev.some((message) => message.id === id)
              ? prev
              : [...prev, { id, role: 'model', text: developerFailureChatText(event.agentId, detail), isNotice: true }]);
          }
          break;
        default: {
          const unhandled: never = event;
          console.error('[SSE] unhandled notification', unhandled);
        }
      }
      void refreshStates(conversationId);
    };
    for (const kind of CLIENT_NOTIFICATION_KINDS) source.addEventListener(kind, onNotification);
    return () => {
      source.close();
    };
  }, [conversationId, refreshStates]);

  const handleFeedback = async (agentId: string, deliverableId: string, value: FeedbackValue | null) => {
    if (!conversationId || feedbackBusy) return;
    const previous = feedback[deliverableId] ?? null;
    const apply = (next: FeedbackValue | null) =>
      setFeedback(({ [deliverableId]: _old, ...rest }) => (next ? { ...rest, [deliverableId]: next } : rest));
    apply(value);
    setFeedbackBusy(true);
    setCommandError('');
    try {
      const result = await deliverableFeedbackAction({ conversationId, deliverableId, value });
      if (!result.ok) {
        apply(previous);
        setCommandErrorAgent(agentId);
        setCommandError(result.message || 'No pudimos guardar tu calificación. Inténtalo de nuevo.');
      }
    } catch (error) {
      console.error('Deliverable feedback failed.', error);
      apply(previous);
      setCommandErrorAgent(agentId);
      setCommandError('No pudimos guardar tu calificación. Inténtalo de nuevo.');
    } finally {
      setFeedbackBusy(false);
    }
  };

  const handleDeliverableCommand = async (agentId: string, view: DeliverableStateView, request: DeliverableCommandRequest) => {
    if (!conversationId || commandBusy) return;
    setCommandBusy(true);
    setCommandError('');
    setCommandErrorAgent(agentId);
    try {
      const base = {
        commandId: crypto.randomUUID(),
        conversationId,
        agentId,
        expectedState: view.state,
        stateToken: view.stateToken,
      };
      const result = await deliverableCommandAction(
        request.kind === 'iterate'
          ? { ...base, kind: 'iterate', deliverableId: request.deliverableId, observation: request.observation }
          : request.kind === 'approve'
            ? { ...base, kind: 'approve', deliverableId: request.deliverableId, expectedApprovedId: view.approvedDeliverableId }
            : request.kind === 'use_own'
              ? { ...base, kind: 'use_own', ...(request.value !== undefined ? { value: request.value } : {}) }
            : request.kind === 'retry'
              ? { ...base, kind: 'retry', failedTaskId: view.lastFailure?.taskId }
              : request.kind === 'cancel'
                ? { ...base, kind: 'cancel', taskId: view.activeTask?.taskId }
                : { ...base, kind: 'generate' },
      );
      if (!result.ok) setCommandError(result.message);
      if (result.states.length > 0) applyStates(result.states);
      else await refreshStates(conversationId);
    } catch (error) {
      console.error('Deliverable command failed.', error);
      setCommandError('No pudimos confirmar esta acción. Revisa el panel antes de intentarlo de nuevo.');
      await refreshStates(conversationId);
    } finally {
      setCommandBusy(false);
    }
  };

  /** D32: upload lab-report PDFs, then issue the label command the fresh state allows (the upload is the user's command). */
  const handleLabUpload = async (files: File[]) => {
    if (!conversationId || !productId || !context?.brandId || files.length === 0 || labUploading) return;
    const forConversation = conversationId;
    setLabUploading(true);
    setCommandError('');
    setCommandErrorAgent(LABEL_AGENT_ID);
    try {
      const { uploaded, errors } = await uploadLabReports(context.brandId, productId, files);
      if (errors.length > 0) setCommandError(errors.join(' '));
      if (uploaded === 0) return;
      await refreshLabReports(forConversation);
      const fresh = await loadDeliverableStatesAction({ conversationId: forConversation });
      if (!fresh.ok || currentConversationRef.current !== forConversation) return;
      applyStates(fresh.states);
      const view = fresh.states.find((candidate) => candidate.agentId === LABEL_AGENT_ID);
      const request = view ? labelCommandAfterUpload(view) : null;
      if (!view || !request) setCommandError(LAB_UPLOAD_WAIT_MESSAGE);
      else await handleDeliverableCommand(LABEL_AGENT_ID, view, request);
    } catch (error) {
      console.error('Lab report upload failed.', error);
      setCommandError('No pudimos subir el análisis. Inténtalo de nuevo.');
    } finally {
      setLabUploading(false);
    }
  };

  /** D32: «Quitar» a lab report, then reload the list. */
  const handleLabRemove = async (fileId: string) => {
    if (!conversationId || labUploading) return;
    setCommandError('');
    setCommandErrorAgent(LABEL_AGENT_ID);
    const error = await removeLabReport(fileId);
    if (error) setCommandError(error);
    await refreshLabReports(conversationId);
  };

  const renderLogoCommands = () => (
    <DeliverableCommands
      view={logoView}
      label="logo"
      busy={commandBusy}
      error={commandErrorAgent === LOGO_AGENT_ID ? commandError : ''}
      onCommand={(request) => { if (logoView) void handleDeliverableCommand(LOGO_AGENT_ID, logoView, request); }}
      feedback={feedback}
      feedbackBusy={feedbackBusy}
      onFeedback={(deliverableId, value) => void handleFeedback(LOGO_AGENT_ID, deliverableId, value)}
      onAdvance={() => document.getElementById('brand-step-3')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
    />
  );

  // A titled card without «Avanzar»: the names and tagline (KAN-31 / KAN-32), and the mobile logo (KAN-29: the type is named).
  const renderTextCommands = (agentId: string, view: DeliverableStateView | undefined, title: string, label: string, note?: string) => view && (
    <section className="mt-6" aria-label={title}>
      <h3 className="text-sm font-semibold text-neutral-700">{title}</h3>
      <DeliverableCommands
        view={view}
        label={label}
        note={note}
        busy={commandBusy}
        error={commandErrorAgent === agentId ? commandError : ''}
        onCommand={(request) => void handleDeliverableCommand(agentId, view, request)}
        feedback={feedback}
        feedbackBusy={feedbackBusy}
        onFeedback={(deliverableId, value) => void handleFeedback(agentId, deliverableId, value)}
      />
    </section>
  );
  // Verbal identity: the name (with the INDECOPI note), then the tagline built on the approved name.
  const renderNameCommands = () => (nameView || taglineView) && (
    <>
      {renderTextCommands(NAME_AGENT_ID, nameView, 'Nombre comercial', 'nombre', NAME_AVAILABILITY_NOTE)}
      {renderTextCommands(TAGLINE_AGENT_ID, taglineView, 'Lema', 'lema')}
    </>
  );

  const renderLabelCard = () => productId ? (
    <LabelCard
      view={labelView}
      reports={labReportNames}
      onRemove={(fileId) => void handleLabRemove(fileId)}
      uploading={labUploading}
      busy={commandBusy || labUploading}
      error={commandErrorAgent === LABEL_AGENT_ID ? commandError : ''}
      onCommand={(request) => { if (labelView) void handleDeliverableCommand(LABEL_AGENT_ID, labelView, request); }}
      feedback={feedback}
      feedbackBusy={feedbackBusy}
      onFeedback={(deliverableId, value) => void handleFeedback(LABEL_AGENT_ID, deliverableId, value)}
    />
  ) : undefined;

  const brandId = context?.brandId ?? null;
  const renderBrandAssets = () => productId ? (
    <BrandAssetsReadOnly
      assets={brandAssets}
      brandConversationId={brandAssets?.brandConversationId ?? null}
    />
  ) : undefined;

  const briefPanel = (
    <BriefPanel fields={briefFields} savingField={briefSaving} error={briefError} onSave={saveBriefField} />
  );

  const handleSend = async () => {
    if (!inputText.trim()) return;
    if (retryTurn || needsNewConversation) return;

    const userText = inputText.trim();
    if (!conversationId) {
      setConversationError('No hay una configuración activa para iniciar una conversación. Contacta al administrador de tu organización.');
      return;
    }
    const requestId = crypto.randomUUID();
    await submitTurn(userText, requestId);
  };

  const submitTurn = async (userText: string, requestId: string) => {
    setInputText('');
    setMessages(prev => prev.some((message) => message.id === `${requestId}:user`)
      ? prev
      : [...prev, { id: `${requestId}:user`, role: 'user', text: userText }]);
    setIsLoading(true);
    const turnConversation = conversationId;

    try {
      const result = await chatAction({ conversationId: turnConversation, requestId, userMessage: userText });
      if (currentConversationRef.current !== turnConversation) return; // the user switched conversations mid-turn
      if (!result.ok) {
        setMessages(prev => [...prev, { id: `${requestId}:error`, role: 'model', text: result.message }]);
        setRetryTurn(result.retryable && !result.uncertain ? { requestId, userMessage: userText } : null);
        setNeedsNewConversation(result.uncertain);
        return;
      }
      setMessages(prev => [
        ...prev,
        {
          id: `${requestId}:assistant`,
          role: 'model',
          text: result.content || 'No pude preparar una respuesta clara. ¿Podrías reformular tu petición?',
        },
        ...result.notices.map((notice, noticeIndex) => ({
          id: `${requestId}:notice:${noticeIndex}`, role: 'model' as const, text: notice.content ?? '', isNotice: true,
        })),
      ]);
      setRetryTurn(null);
      setNeedsNewConversation(false);
      void refreshBrief(turnConversation);
    } catch (error: unknown) {
      console.error('Chat request failed.', error);
      if (currentConversationRef.current !== turnConversation) return;
      const text = 'No pudimos confirmar el resultado de esta solicitud. Recarga la conversación antes de continuar.';
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text }]);
      setRetryTurn(null);
    } finally {
      if (currentConversationRef.current === turnConversation) setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** Open a freshly created conversation: reset every per-conversation state and move the URL. */
  const openConversation = (result: Extract<NewOwnedConversation, { ok: true }>) => {
    setAssets(EMPTY_ASSETS);
    setMessages([welcomeMessage(result.welcome)]);
    currentConversationRef.current = result.conversationId;
    setConversationId(result.conversationId);
    setIsLoading(false);
    setContext(result.context);
    setRetryTurn(null);
    setNeedsNewConversation(false);
    setConversationError('');
    setProcessingAgents(new Set());
    setLiveLost(false);
    setDeliverableStates([]);
    setBriefFields([]);
    setBriefError(null);
    setCommandError('');
    setLabReportNames([]);
    setNotFound(false);
    window.history.pushState({}, '', `/?conversationId=${encodeURIComponent(result.conversationId)}`);
  };

  const toFormResult = (result: Extract<NewOwnedConversation, { ok: false }> | { ok: false; message: string; fieldErrors?: Record<string, string> }): FormResult =>
    ({ ok: false, message: result.message, fieldErrors: result.fieldErrors });

  const UPLOAD_PARTIAL = 'Guardamos los datos, pero no pudimos subir algunos archivos. Corrígelos y vuelve a guardar, o cierra para continuar.';

  const submitBrand = async (mode: BrandFormMode, brandId: string | undefined, attributes: Record<string, unknown>, files: BrandFiles): Promise<BrandFormResult> => {
    let targetId = brandId;
    let opened = pendingOpen;
    if (mode === 'edit' && brandId) {
      const result = await updateBrandAction({ brandId, attributes });
      if (!result.ok) return toFormResult(result as Parameters<typeof toFormResult>[0]);
      setContext((prev) => (prev && prev.brandId === brandId ? { ...prev, brandName: result.name } : prev));
    } else {
      const result = await createBrandAction({ attributes, imported: mode === 'import' });
      if (!result.ok) return toFormResult(result);
      targetId = result.brandId;
      opened = result;
    }
    const { errors, remaining } = await uploadBrandFiles(targetId!, files);
    if (errors.length > 0) {
      // Keep the form open on the brand that now exists; its conversation opens when the form closes or the upload succeeds.
      if (opened) setPendingOpen(opened);
      setFormModal({ kind: 'brand', mode: 'edit', brandId: targetId, initial: attributes });
      return { ok: false, message: UPLOAD_PARTIAL, uploadErrors: errors, remaining };
    }
    setPendingOpen(null);
    if (opened) openConversation(opened);
    setFormModal(null);
    return { ok: true };
  };

  /** Close the form; a created brand waiting for its files still gets its conversation opened. */
  const closeForm = () => {
    if (pendingOpen) openConversation(pendingOpen);
    setPendingOpen(null);
    setFormModal(null);
  };

  const submitProduct = async (modal: Extract<FormModalState, { kind: 'product' }>, attributes: Record<string, unknown>): Promise<FormResult> => {
    if (modal.mode === 'edit' && modal.productId) {
      const result = await updateProductAction({ productId: modal.productId, attributes });
      if (!result.ok) return toFormResult(result as Parameters<typeof toFormResult>[0]);
      setContext((prev) => (prev && prev.productId === modal.productId ? { ...prev, productName: result.name } : prev));
    } else {
      const result = await createProductAction({ brandId: modal.brandId ?? '', attributes });
      if (!result.ok) return toFormResult(result);
      openConversation(result);
    }
    setFormModal(null);
    return { ok: true };
  };

  const openEditBrand = async (brandId: string) => {
    const result = await getBrandAction({ brandId });
    if (!result.ok) { setConversationError(result.message); return; }
    setFormModal({ kind: 'brand', mode: 'edit', brandId, initial: result.attributes, files: result.files });
  };
  const openNewProduct = async (brandId: string) => {
    const result = await getBrandAction({ brandId });
    if (!result.ok) { setConversationError(result.message); return; }
    setFormModal({ kind: 'product', mode: 'create', brandId, brandAttributes: result.attributes });
  };
  const openEditProduct = async (productId: string) => {
    const result = await getProductAction({ productId });
    if (!result.ok) { setConversationError(result.message); return; }
    setFormModal({ kind: 'product', mode: 'edit', productId, initial: result.attributes, brandAttributes: result.brandAttributes });
  };

  const handleArchiveBrand = (brandId: string) => {
    void archiveBrandAction({ brandId }).then((result) => {
      // Reload through `/`: it opens the latest remaining conversation, or the empty state if none is left.
      if (result.ok) window.location.assign('/');
      else setConversationError(result.message);
    });
  };

  const handleExportConversation = async () => {
    if (!conversationId) return;
    const result = await exportConversationTraceAction({ conversationId });
    if (!result.ok) {
      setConversationError(result.message);
      return;
    }
    const blob = new Blob([result.content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `crea-mype-conversation-${conversationId}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };


  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900 overflow-hidden font-sans">

      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} isSidebarOpen={isSidebarOpen} setIsSidebarOpen={setIsSidebarOpen} assets={assets} processingAgents={processingAgents} userEmail={userEmail} userName={userName} />
      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden relative">

      {formModal?.kind === 'brand' && (
        <FormModal title={brandFormTitle(formModal.mode)} onClose={closeForm}>
          <BrandForm
            mode={formModal.mode}
            initialValues={formModal.initial}
            existingFiles={formModal.files}
            onSubmit={(attributes, files) => submitBrand(formModal.mode, formModal.brandId, attributes, files)}
            onCancel={closeForm}
          />
        </FormModal>
      )}
      {formModal?.kind === 'product' && (
        <FormModal title={productFormTitle(formModal.mode)} onClose={closeForm}>
          <ProductForm
            mode={formModal.mode}
            initialValues={formModal.initial}
            brandAttributes={formModal.brandAttributes}
            onSubmit={(attributes) => submitProduct(formModal, attributes)}
            onCancel={closeForm}
          />
        </FormModal>
      )}
      {activeTab === 'create' && (
        <>
          <ChatPanel labUpload={productId ? { busy: labUploading || commandBusy, onFiles: (files) => void handleLabUpload(files) } : undefined} assets={assets} processingAgents={processingAgents} conversationId={conversationId} handleExportConversation={handleExportConversation} onCreateBrand={() => setFormModal({ kind: 'brand', mode: 'create' })} onImportBrand={() => setFormModal({ kind: 'brand', mode: 'import' })} context={context} messages={messages} isLoading={isLoading} messagesEndRef={messagesEndRef} conversationError={conversationError} retryTurn={retryTurn} submitTurn={submitTurn} inputText={inputText} setInputText={setInputText} handleKeyDown={handleKeyDown} handleSend={handleSend} needsNewConversation={needsNewConversation} mobileDeliverablePanel={briefFields.length > 0 || productId || logoView || nameView || taglineView || labelView ? (
            <>
              {briefFields.length > 0 && (
                <details className="mb-2">
                  <summary className="cursor-pointer text-sm font-medium text-neutral-700">Datos de tu marca y producto</summary>
                  <div className="mt-2 max-h-[50vh] overflow-y-auto">{briefPanel}</div>
                </details>
              )}
              {productId ? (
                <>
                  <div className="mt-2"><h3 className="text-sm font-semibold text-neutral-700">Etiqueta nutricional</h3>{renderLabelCard()}</div>
                  <div className="mt-6"><h3 className="text-sm font-semibold text-neutral-700">Recursos de tu marca</h3>{renderBrandAssets()}</div>
                </>
              ) : (
                <>
                  {renderNameCommands()}
                  {renderTextCommands(LOGO_AGENT_ID, logoView, 'Logo', 'logo')}
                </>
              )}
            </>
          ) : undefined} conversationNotFound={notFound} liveConnectionLost={liveLost} creationBlocked={creationBlocked} conversationMenu={creationBlocked ? undefined :
            <ConversationMenu initialConversations={initialConversations} initialBrands={initialBrands} currentConversationId={conversationId} onCreateBrand={() => setFormModal({ kind: 'brand', mode: 'create' })} onImportBrand={() => setFormModal({ kind: 'brand', mode: 'import' })} onNewProduct={(brandId) => void openNewProduct(brandId)} onEditBrand={(brandId) => void openEditBrand(brandId)} onEditProduct={(productId) => void openEditProduct(productId)} onArchiveBrand={handleArchiveBrand} loadConversations={listConversationsAction} />
          } />
          <Dashboard assets={assets} processingAgents={logoView?.state === 'generating' ? new Set([...processingAgents, LOGO_AGENT_ID]) : processingAgents} step={step} setActiveTab={setActiveTab} logoControls={renderLogoCommands()} nameControls={renderNameCommands()} labelControls={renderLabelCard()} brandAssetsPanel={renderBrandAssets()} briefPanel={briefFields.length > 0 ? briefPanel : undefined} />
      </>
      )}

      {activeTab === 'landing' && <LandingPreview assets={assets} setActiveTab={setActiveTab} />}

      </div>
    </div>
  );
}
