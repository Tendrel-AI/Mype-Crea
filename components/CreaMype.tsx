'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './crea-mype/Sidebar';
import { type BrandAssets, type Message, type Step } from './crea-mype/types';
import { RestartModal } from './crea-mype/RestartModal';
import { ChatPanel } from './crea-mype/ChatPanel';
import { Dashboard } from './crea-mype/Dashboard';
import { LandingPreview } from './crea-mype/LandingPreview';
import { DeliverableCommands, type DeliverableCommandRequest } from './crea-mype/DeliverableCommands';
import { chatAction } from '../app/actions/chat';
import { createConversationAction, exportConversationTraceAction } from '../app/actions/conversations';
import { deliverableCommandAction, loadDeliverableStatesAction } from '../app/actions/deliverable-command';
import type { DeliverableStateView } from '../src/core/contracts';

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
  /** Optional validated-on-render typed v1 landing-page envelope. No live producer exists yet. */
  landingPageContent?: unknown;
  initialError?: string;
}

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'model',
  text: '¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.\n\n**Paso 1: Nombre del Negocio**\nPara empezar, cuéntame un poco sobre tu idea: ¿En qué industria estás? ¿Cuáles son tus valores principales? ¿A quién va dirigido tu producto?',
  isSystem: true,
};

const LOGO_AGENT_ID = 'logo-agent';

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

export default function CreaMype({ userEmail, userName, initialConversationId = '', initialTurns = [], initialDeliverables = [], landingPageContent, initialError }: CreaMypeProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'gallery' | 'landing'>('create');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [assets, setAssets] = useState<BrandAssets>(() => ({
    ...EMPTY_ASSETS,
    logoUrl: initialLogoUrl(initialDeliverables),
    typedLandingPage: landingPageContent,
  }));
  const [messages, setMessages] = useState<Message[]>(() => initialTurns.length
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
  const [deliverableStates, setDeliverableStates] = useState<ReadonlyArray<DeliverableStateView>>([]);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState('');
  const logoView = deliverableStates.find((view) => view.agentId === LOGO_AGENT_ID);

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
    void refreshStates(conversationId);
  }, [conversationId, refreshStates]);

  // Subscribe to artifact events from the orchestrator. The SSE stream is
  // scoped to the current conversationId; resetting the conversation
  // (Nuevo button) closes the old EventSource and opens a fresh one.
  useEffect(() => {
    if (!conversationId) return;
    const url = `/api/agents/stream?conversationId=${conversationId}`;
    const source = new EventSource(url);
    source.addEventListener('open', () => {
      console.info('[SSE] connected', { conversationId, readyState: source.readyState });
    });
    source.addEventListener('error', () => {
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
    source.addEventListener('task_processing', (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as { agentId: string };
        setProcessingAgents((prev) => {
          const next = new Set(prev);
          next.add(event.agentId);
          return next;
        });
        void refreshStates(conversationId);
      } catch (err) {
        console.error('Failed to parse task_processing event', err);
      }
    });
    source.addEventListener('artifact', (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as {
          agentId: string;
          artifacts: Array<{ kind: string; url?: string }>;
        };
        // Whatever the agent produced, the spinner for that agent should
        // disappear. Even if there's no image url (text-only artifact), the
        // task is no longer "processing".
        setProcessingAgents((prev) => {
          if (!prev.has(event.agentId)) return prev;
          const next = new Set(prev);
          next.delete(event.agentId);
          return next;
        });
        void refreshStates(conversationId);
        const imgUrl = event.artifacts.find((a) => a.kind === 'image')?.url;
        if (!imgUrl) return;
        if (event.agentId === LOGO_AGENT_ID) {
          setAssets((prev) => ({ ...prev, logoUrl: imgUrl }));
        }
      } catch (err) {
        console.error('Failed to parse artifact event', err);
      }
    });
    // A failed or canceled task arrives as a notice; the panel state changes too.
    source.addEventListener('notice', (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as { agentId?: string };
        if (event.agentId) {
          setProcessingAgents((prev) => {
            if (!prev.has(event.agentId!)) return prev;
            const next = new Set(prev);
            next.delete(event.agentId!);
            return next;
          });
        }
      } catch {
        // Notices without a JSON body still trigger a refresh.
      }
      void refreshStates(conversationId);
    });
    return () => {
      source.close();
    };
  }, [conversationId, refreshStates]);

  const handleDeliverableCommand = async (agentId: string, view: DeliverableStateView, request: DeliverableCommandRequest) => {
    if (!conversationId || commandBusy) return;
    setCommandBusy(true);
    setCommandError('');
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

  const renderLogoCommands = (withAdvance: boolean) => (
    <DeliverableCommands
      view={logoView}
      label="logo"
      busy={commandBusy}
      error={commandError}
      onCommand={(request) => { if (logoView) void handleDeliverableCommand(LOGO_AGENT_ID, logoView, request); }}
      onAdvance={withAdvance
        ? () => document.getElementById('brand-step-3')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        : undefined}
    />
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
      void refreshStates(conversationId);
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
        setDeliverableStates([]);
        setCommandError('');
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
          <ChatPanel assets={assets} processingAgents={processingAgents} conversationId={conversationId} handleExportConversation={handleExportConversation} step={step} setShowRestartModal={setShowRestartModal} messages={messages} isLoading={isLoading} messagesEndRef={messagesEndRef} conversationError={conversationError} retryTurn={retryTurn} submitTurn={submitTurn} inputText={inputText} setInputText={setInputText} handleKeyDown={handleKeyDown} handleSend={handleSend} needsNewConversation={needsNewConversation} mobileDeliverablePanel={logoView ? renderLogoCommands(false) : undefined} />
          <Dashboard assets={assets} processingAgents={logoView?.state === 'generating' ? new Set([...processingAgents, LOGO_AGENT_ID]) : processingAgents} step={step} setActiveTab={setActiveTab} logoControls={renderLogoCommands(true)} />
      </>
      )}

      {activeTab === 'landing' && <LandingPreview assets={assets} setActiveTab={setActiveTab} />}

      </div>
    </div>
  );
}
