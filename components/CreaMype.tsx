'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './crea-mype/Sidebar';
import { type BrandAssets, type Message, type Step } from './crea-mype/types';
import { RestartModal } from './crea-mype/RestartModal';
import { ConversationMenu } from './crea-mype/ConversationMenu';
import { ChatPanel } from './crea-mype/ChatPanel';
import { Dashboard } from './crea-mype/Dashboard';
import { LandingPreview } from './crea-mype/LandingPreview';
import { DeliverableCommands, NAME_AVAILABILITY_NOTE, type DeliverableCommandRequest } from './crea-mype/DeliverableCommands';
import { BriefPanel } from './crea-mype/BriefPanel';
import { loadBriefAction, updateBriefFieldAction, type BriefPanelField } from '../app/actions/brief';
import { chatAction } from '../app/actions/chat';
import { createConversationAction, exportConversationTraceAction, listConversationsAction } from '../app/actions/conversations';
import type { ConversationListEntry } from '../src/conversations/selection';
import { deliverableCommandAction, loadDeliverableStatesAction } from '../app/actions/deliverable-command';
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
  /** KAN-25: the requested id is foreign, missing or malformed (one identical outcome). */
  conversationNotFound?: boolean;
}

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'model',
  text: '¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.\n\n**Paso 1: Nombre del Negocio**\nPara empezar, cuéntame un poco sobre tu idea: ¿En qué industria estás? ¿Cuáles son tus valores principales? ¿A quién va dirigido tu producto?',
  isSystem: true,
};

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

export default function CreaMype({ userEmail, userName, initialConversationId = '', initialTurns = [], initialDeliverables = [], initialBrief = [], initialStates = [], landingPageContent, initialError, initialConversations = [], conversationNotFound = false }: CreaMypeProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'gallery' | 'landing'>('create');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [assets, setAssets] = useState<BrandAssets>(() => ({
    ...EMPTY_ASSETS,
    logoUrl: initialLogoUrl(initialDeliverables),
    typedLandingPage: landingPageContent,
  }));
  const [notFound, setNotFound] = useState(conversationNotFound);
  const [messages, setMessages] = useState<Message[]>(() => conversationNotFound ? [] : initialTurns.length
    ? initialTurns.flatMap((turn) => [
        ...(turn.userMessage ? [{ id: `${turn.requestId}:user`, role: 'user' as const, text: turn.userMessage }] : []),
        ...(turn.content ? [{ id: `${turn.requestId}:assistant`, role: 'model' as const, text: turn.content }] : []),
        ...turn.notices.filter((notice) => notice.content).map((notice, noticeIndex) => ({
          id: `${turn.requestId}:notice:${noticeIndex}`, role: 'model' as const, text: notice.content!, isNotice: true,
        })),
      ])
    : [WELCOME_MESSAGE]);
  const incompleteTurn = [...initialTurns].reverse().find((turn) => turn.stage !== 'responded');
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  // Set of agent ids that are currently processing (claimed but no artifact
  // delivered yet). Populated by `task_processing` SSE events from the worker
  // and cleared by `artifact` events. Drives the per-panel spinner.
  const [processingAgents, setProcessingAgents] = useState<Set<string>>(() => new Set());

  // Server-side conversations.id — generated once per session, regenerated on
  // "Nuevo". Threaded into chatAction so messages and llm_calls rows are
  // attributed to the right conversation row.
  const [conversationId, setConversationId] = useState<string>(initialConversationId);
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
  const logoView = deliverableStates.find((view) => view.agentId === LOGO_AGENT_ID);
  const nameView = deliverableStates.find((view) => view.agentId === NAME_AGENT_ID);
  const taglineView = deliverableStates.find((view) => view.agentId === TAGLINE_AGENT_ID);
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
      if (result.ok) applyStates(result.states);
    } catch (error) {
      console.error('Failed to load deliverable states', error);
    }
  }, [applyStates]);

  /** Brief plus deliverable states, both read from the server. */
  const refreshBrief = useCallback(async (forConversation: string) => {
    if (!forConversation) return;
    try {
      const result = await loadBriefAction({ conversationId: forConversation });
      if (!result.ok) return;
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

  const renderLogoCommands = () => (
    <DeliverableCommands
      view={logoView}
      label="logo"
      busy={commandBusy}
      error={commandErrorAgent === LOGO_AGENT_ID ? commandError : ''}
      onCommand={(request) => { if (logoView) void handleDeliverableCommand(LOGO_AGENT_ID, logoView, request); }}
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

    try {
      const result = await chatAction({ conversationId, requestId, userMessage: userText });
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
      void refreshBrief(conversationId);
    } catch (error: unknown) {
      console.error('Chat request failed.', error);
      const text = 'No pudimos confirmar el resultado de esta solicitud. Recarga la conversación antes de continuar.';
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text }]);
      setRetryTurn(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRestart = () => {
    void (async () => {
      setIsLoading(true);
      try {
        const result = await createConversationAction();
        if (!result.ok) {
          setConversationError(result.message);
          return;
        }
        setAssets(EMPTY_ASSETS);
        setMessages([WELCOME_MESSAGE]);
        setConversationId(result.conversationId);
        setRetryTurn(null);
        setNeedsNewConversation(false);
        setConversationError('');
        setProcessingAgents(new Set());
        setLiveLost(false);
        setDeliverableStates([]);
        setBriefFields([]);
        setBriefError(null);
        setCommandError('');
        setNotFound(false);
        window.history.pushState({}, '', `/?conversationId=${encodeURIComponent(result.conversationId)}`);
        setShowRestartModal(false);
      } finally {
        setIsLoading(false);
      }
    })();
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

      <RestartModal showRestartModal={showRestartModal} setShowRestartModal={setShowRestartModal} handleRestart={handleRestart} />
      {activeTab === 'create' && (
        <>
          <ChatPanel assets={assets} processingAgents={processingAgents} conversationId={conversationId} handleExportConversation={handleExportConversation} step={step} setShowRestartModal={setShowRestartModal} messages={messages} isLoading={isLoading} messagesEndRef={messagesEndRef} conversationError={conversationError} retryTurn={retryTurn} submitTurn={submitTurn} inputText={inputText} setInputText={setInputText} handleKeyDown={handleKeyDown} handleSend={handleSend} needsNewConversation={needsNewConversation} mobileDeliverablePanel={briefFields.length > 0 || logoView || nameView || taglineView ? (
            <>
              {briefFields.length > 0 && (
                <details className="mb-2">
                  <summary className="cursor-pointer text-sm font-medium text-neutral-700">Datos de tu marca y producto</summary>
                  <div className="mt-2 max-h-[50vh] overflow-y-auto">{briefPanel}</div>
                </details>
              )}
              {renderNameCommands()}
              {renderTextCommands(LOGO_AGENT_ID, logoView, 'Logo', 'logo')}
            </>
          ) : undefined} conversationNotFound={notFound} liveConnectionLost={liveLost} conversationMenu={
            <ConversationMenu initialConversations={initialConversations} currentConversationId={conversationId} onNewConversation={() => setShowRestartModal(true)} loadConversations={listConversationsAction} />
          } />
          <Dashboard assets={assets} processingAgents={logoView?.state === 'generating' ? new Set([...processingAgents, LOGO_AGENT_ID]) : processingAgents} step={step} setActiveTab={setActiveTab} logoControls={renderLogoCommands()} nameControls={renderNameCommands()} briefPanel={briefFields.length > 0 ? briefPanel : undefined} />
      </>
      )}

      {activeTab === 'landing' && <LandingPreview assets={assets} setActiveTab={setActiveTab} />}

      </div>
    </div>
  );
}
