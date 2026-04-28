'use client';

import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, Sparkles, Image as ImageIcon, LayoutTemplate, Megaphone, CheckCircle2, LogOut, Menu, Globe, PlusCircle } from 'lucide-react';
import { generateImageAction } from '../app/actions/image';
import { signOutAction } from '../app/actions/auth';
import { chatAction, chatActionStep1, type ChatMessage } from '../app/actions/chat';

interface CreaMypeProps {
  userEmail: string;
  userName: string;
}

const cleanHtmlContent = (html: string) => {
  if (!html) return '';
  let cleaned = html.trim();

  // Remove markdown backticks if present
  if (cleaned.startsWith('```html')) {
    cleaned = cleaned.replace(/^```html\n?/, '').replace(/\n?```$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\n?/, '').replace(/\n?```$/, '');
  }

  // Extract body content if the model included full HTML tags
  const bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch && bodyMatch[1]) {
    cleaned = bodyMatch[1];
  }

  return cleaned.trim();
};

type Step = 1 | 2 | 3 | 4 | 5 | 6;

interface BrandAssets {
  name: string;
  profile: string;
  logoUrl: string;
  labelUrl: string;
  landingPage: string;
  marketingPlan: string;
}

interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  isImage?: boolean;
  imageUrl?: string;
  imageAssetKey?: 'logoUrl' | 'labelUrl';
  isSystem?: boolean;
}

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'model',
  text: '¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.\n\n**Paso 1: Nombre del Negocio**\nPara empezar, cuéntame un poco sobre tu idea: ¿En qué industria estás? ¿Cuáles son tus valores principales? ¿A quién va dirigido tu producto?',
  isSystem: true,
};

const EMPTY_ASSETS: BrandAssets = {
  name: '',
  profile: '',
  logoUrl: '',
  labelUrl: '',
  landingPage: '',
  marketingPlan: '',
};

export default function CreaMype({ userEmail, userName }: CreaMypeProps) {
  const [activeTab, setActiveTab] = useState<'create' | 'gallery' | 'landing'>('create');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  const [step, setStep] = useState<Step>(1);
  const [assets, setAssets] = useState<BrandAssets>(EMPTY_ASSETS);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [showRestartModal, setShowRestartModal] = useState(false);

  // Server-side conversations.id — generated once per session, regenerated on
  // "Nuevo". Threaded into chatAction so messages and llm_calls rows are
  // attributed to the right conversation row.
  const [conversationId, setConversationId] = useState<string>(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : '',
  );

  // OpenAI-compatible chat history (sent to OpenRouter via chatAction)
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSend = async () => {
    if (!inputText.trim()) return;

    const userText = inputText.trim();
    setInputText('');

    const newUserMsg: Message = { id: Date.now().toString(), role: 'user', text: userText };
    setMessages(prev => [...prev, newUserMsg]);

    const currentHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: userText }];

    setIsLoading(true);
    setLoadingStatus('Analizando...');

    // Paso 1 (nombre del negocio) runs through the 4-layer orchestrator:
    //   ChatInputAdapter (Flash) → core (merge + planner) → name-agent →
    //   ChatOutputAdapter (Pro). Pasos 2-5 stay on the legacy tool-driven
    //   chatAction below.
    if (step === 1) {
      try {
        const result = await chatActionStep1({
          conversationId,
          lastUserInput: userText,
        });

        // Mirror the turn into the OpenAI-compatible history so when we
        // hand off to chatAction in step 2 the conversation reads continuously.
        const updatedHistory: ChatMessage[] = [
          ...currentHistory,
          { role: 'assistant', content: result.content || null },
        ];
        setChatHistory(updatedHistory);

        setMessages(prev => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'model',
            text: result.content || 'Lo siento, no pude generar una respuesta. ¿Puedes intentar de nuevo?',
          },
        ]);

        if (
          result.decision.kind === 'announce_completion' &&
          result.decision.agentId === 'name-agent'
        ) {
          setAssets(prev => ({
            ...prev,
            name: result.extractedAssets.name ?? prev.name,
            profile: result.extractedAssets.profile ?? prev.profile,
          }));
          setStep(2);
        }
      } catch (error: any) {
        console.error('chatActionStep1 error:', error);
        setMessages(prev => [
          ...prev,
          {
            id: Date.now().toString(),
            role: 'model',
            text: 'Hubo un error al procesar tu solicitud. Por favor, intenta de nuevo.',
          },
        ]);
      } finally {
        setIsLoading(false);
        setLoadingStatus('');
      }
      return;
    }

    let currentLogoUrl = assets.logoUrl;
    let currentLabelUrl = assets.labelUrl;
    let currentStep = step;
    const currentAssets = { ...assets };

    try {
      let keepProcessing = true;
      let loopCount = 0;
      const MAX_LOOPS = 10;

      while (keepProcessing) {
        loopCount++;
        if (loopCount > MAX_LOOPS) {
          throw new Error("La IA se ha atascado intentando realizar la tarea. Por favor, intenta de nuevo con instrucciones más simples.");
        }

        const { content, toolCalls } = await chatAction({
          conversationId,
          messages: currentHistory,
          step: currentStep,
          assets: currentAssets,
          // Persist the user input only on the first round-trip of this send;
          // subsequent loop iterations are tool follow-ups, not new user turns.
          lastUserInput: loopCount === 1 ? userText : undefined,
        });

        currentHistory.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });

        if (toolCalls.length > 0) {
          for (const call of toolCalls) {
            const args = JSON.parse(call.function.arguments || '{}');
            const name = call.function.name;
            let functionResponseData: any = { success: true };

            try {
              if (name === 'finalize_name') {
                setLoadingStatus('Guardando perfil de negocio...');
                currentAssets.name = args.business_name;
                currentAssets.profile = args.business_profile;
                currentStep = 2;
                setAssets(prev => ({ ...prev, name: args.business_name, profile: args.business_profile }));
                setStep(2);
                functionResponseData = { message: "Nombre guardado exitosamente. Avanzando al Paso 2." };
              }
              else if (name === 'generate_logo') {
                setLoadingStatus('Generando logo con IA (esto puede tomar unos segundos)...');
                const imageUrl = await generateImageAction(args.image_prompt);
                currentLogoUrl = imageUrl;
                currentAssets.logoUrl = imageUrl;
                currentStep = 3;
                setAssets(prev => ({ ...prev, logoUrl: imageUrl }));
                setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Aquí tienes el concepto del logo:', isImage: true, imageAssetKey: 'logoUrl' }]);
                setStep(3);
                functionResponseData = { message: "Logo generado y guardado exitosamente. Avanzando al Paso 3." };
              }
              else if (name === 'generate_label') {
                setLoadingStatus('Generando diseño de etiqueta con IA...');
                const imageUrl = await generateImageAction(args.image_prompt, currentLogoUrl);
                currentLabelUrl = imageUrl;
                currentAssets.labelUrl = imageUrl;
                currentStep = 4;
                setAssets(prev => ({ ...prev, labelUrl: imageUrl }));
                setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Aquí tienes el diseño de la etiqueta:', isImage: true, imageAssetKey: 'labelUrl' }]);
                setStep(4);
                functionResponseData = { message: "Etiqueta generada y guardada exitosamente. Avanzando al Paso 4." };
              }
              else if (name === 'finalize_landing_page' || name === 'edit_landing_page') {
                setLoadingStatus(name === 'finalize_landing_page' ? 'Construyendo landing page...' : 'Actualizando landing page...');
                const htmlContent = cleanHtmlContent(args.html_content);

                if (!htmlContent || htmlContent.length < 150 || !htmlContent.includes('<div') || !htmlContent.includes('class=')) {
                  throw new Error("El HTML generado es inválido, está incompleto o no usa Tailwind CSS. Por favor, genera el código HTML completo y detallado (solo el contenido del <body>) usando clases de Tailwind CSS. No uses markdown.");
                }

                currentAssets.landingPage = htmlContent;
                setAssets(prev => ({ ...prev, landingPage: htmlContent }));

                if (name === 'finalize_landing_page') {
                  currentStep = 5;
                  setStep(5);
                  functionResponseData = { message: "Landing page guardada exitosamente. Avanzando al Paso 5." };
                } else {
                  functionResponseData = { message: "Landing page actualizada exitosamente." };
                }
              }
              else if (name === 'finalize_marketing') {
                setLoadingStatus('Finalizando plan de marketing...');
                currentAssets.marketingPlan = args.markdown_content;
                currentStep = 6;
                setAssets(prev => ({ ...prev, marketingPlan: args.markdown_content }));
                setStep(6);
                functionResponseData = { message: "Plan de marketing guardado exitosamente. Flujo completado." };
              }
              else if (name === 'edit_logo') {
                setLoadingStatus('Editando logo con IA...');
                const imageUrl = await generateImageAction(args.image_prompt, currentLogoUrl);
                currentLogoUrl = imageUrl;
                currentAssets.logoUrl = imageUrl;
                setAssets(prev => ({ ...prev, logoUrl: imageUrl }));
                setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Aquí tienes el logo actualizado:', isImage: true, imageAssetKey: 'logoUrl' }]);
                functionResponseData = { message: "Logo editado y actualizado exitosamente." };
              }
              else if (name === 'edit_label') {
                setLoadingStatus('Editando etiqueta con IA...');
                const imageUrl = await generateImageAction(args.image_prompt, currentLabelUrl);
                currentLabelUrl = imageUrl;
                currentAssets.labelUrl = imageUrl;
                setAssets(prev => ({ ...prev, labelUrl: imageUrl }));
                setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Aquí tienes la etiqueta actualizada:', isImage: true, imageAssetKey: 'labelUrl' }]);
                functionResponseData = { message: "Etiqueta editada y actualizada exitosamente." };
              }
              else if (name === 'edit_marketing_plan') {
                setLoadingStatus('Actualizando plan de marketing...');
                currentAssets.marketingPlan = args.markdown_content;
                setAssets(prev => ({ ...prev, marketingPlan: args.markdown_content }));
                functionResponseData = { message: "Plan de marketing actualizado exitosamente." };
              }
            } catch (err: any) {
              console.error("Error executing tool:", err);
              functionResponseData = { success: false, error: err.message };
            }

            currentHistory.push({
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify(functionResponseData),
            });

            if (functionResponseData.success) {
              setLoadingStatus('Escribiendo respuesta...');
            }
          }
        } else {
          if (content) {
            setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: content }]);
          } else {
            setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Lo siento, no pude generar una respuesta clara. ¿Podrías reformular tu petición?' }]);
          }
          keepProcessing = false;
        }
      }

      setChatHistory(currentHistory);

    } catch (error: any) {
      console.error("Chat error:", error);
      if (error.message?.includes('FAL_KEY')) {
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Error: La clave FAL_KEY no está configurada.' }]);
      } else if (error.message?.includes('OPENROUTER_API_KEY')) {
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Error: La clave OPENROUTER_API_KEY no está configurada.' }]);
      } else {
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Hubo un error al procesar tu solicitud. Por favor, intenta de nuevo.' }]);
      }
    } finally {
      setIsLoading(false);
      setLoadingStatus('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleRestart = () => {
    setStep(1);
    setAssets(EMPTY_ASSETS);
    setMessages([WELCOME_MESSAGE]);
    setChatHistory([]);
    setConversationId(crypto.randomUUID());
    setShowRestartModal(false);
  };

  const steps = [
    { num: 1, title: 'Nombre', icon: Sparkles },
    { num: 2, title: 'Logo', icon: ImageIcon },
    { num: 3, title: 'Etiqueta', icon: ImageIcon },
    { num: 4, title: 'Web', icon: LayoutTemplate },
    { num: 5, title: 'Marketing', icon: Megaphone },
  ];

  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900 overflow-hidden font-sans">

      {/* Sidebar */}
      <motion.div
        animate={{ width: isSidebarOpen ? 260 : 64 }}
        className="h-full bg-white border-r border-neutral-200 flex flex-col flex-shrink-0 z-20 transition-all duration-300 overflow-hidden"
      >
        <div className="p-4 flex items-center justify-between border-b border-neutral-100">
          <AnimatePresence>
            {isSidebarOpen && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-2 font-bold text-lg text-orange-600 truncate"
              >
                {assets.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={assets.logoUrl} alt="Logo" className="w-6 h-6 rounded-md object-cover" />
                ) : (
                  <Sparkles className="w-5 h-5" />
                )}
                <span>CreaMype</span>
              </motion.div>
            )}
          </AnimatePresence>
          <button
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-500 transition-colors flex-shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 py-4 flex flex-col gap-2 px-3">
          <button
            onClick={() => setActiveTab('create')}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${activeTab === 'create' ? 'bg-orange-50 text-orange-600' : 'hover:bg-neutral-100 text-neutral-600'}`}
            title="Crea tu producto"
          >
            <PlusCircle className="w-5 h-5 flex-shrink-0" />
            <span className={`font-medium whitespace-nowrap transition-opacity ${isSidebarOpen ? 'opacity-100' : 'opacity-0 hidden'}`}>
              Crea tu producto
            </span>
          </button>

          <button
            onClick={() => setActiveTab('landing')}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${activeTab === 'landing' ? 'bg-orange-50 text-orange-600' : 'hover:bg-neutral-100 text-neutral-600'}`}
            title="Visualizar página web"
          >
            <Globe className="w-5 h-5 flex-shrink-0" />
            <span className={`font-medium whitespace-nowrap transition-opacity ${isSidebarOpen ? 'opacity-100' : 'opacity-0 hidden'}`}>
              Página Web
            </span>
          </button>
        </div>

        <div className="p-3 border-t border-neutral-100">
          {isSidebarOpen && (
            <div className="px-3 py-2 text-xs text-neutral-500 truncate" title={userEmail}>
              <div className="font-medium text-neutral-700 truncate">{userName}</div>
              <div className="truncate">{userEmail}</div>
            </div>
          )}
          <form action={signOutAction}>
            <button
              type="submit"
              className="flex items-center gap-3 px-3 py-2.5 w-full rounded-xl hover:bg-neutral-100 text-neutral-500 transition-colors"
              title="Cerrar sesión"
            >
              <span className={`font-medium whitespace-nowrap transition-opacity ${isSidebarOpen ? 'opacity-100' : 'opacity-0 hidden'}`}>
                Cerrar sesión
              </span>
            </button>
          </form>

        </div>
      </motion.div>

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden relative">

      {/* Restart Modal */}
      <AnimatePresence>
        {showRestartModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white rounded-2xl p-6 max-w-sm w-full mx-4 shadow-xl border border-neutral-200"
            >
              <h3 className="text-lg font-bold text-neutral-900 mb-2">¿Crear nuevo producto?</h3>
              <p className="text-neutral-600 text-sm mb-6">
                Esto iniciará un nuevo proceso de creación y descartará el producto actual.
              </p>
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setShowRestartModal(false)}
                  className="px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleRestart}
                  className="px-4 py-2 text-sm font-medium text-white bg-orange-600 hover:bg-orange-700 rounded-lg transition-colors"
                >
                  Sí, crear nuevo
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {activeTab === 'create' && (
        <>
          {/* Left Panel: Chat Interface */}
      <div className="w-full md:w-1/2 lg:w-5/12 flex flex-col border-r border-neutral-200 bg-white/50 relative z-10">
        <div className="p-4 border-b border-neutral-200 bg-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-orange-500/20 flex items-center justify-center text-orange-500 overflow-hidden">
              {assets.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={assets.logoUrl} alt="Logo" className="w-full h-full object-cover" />
              ) : (
                <Sparkles size={18} />
              )}
            </div>
            <h1 className="font-semibold text-lg tracking-tight">CreaMype</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-xs font-medium px-2.5 py-1 rounded-full bg-neutral-100 text-neutral-600">
              Paso {Math.min(step, 5)} de 5
            </div>
            <button
              onClick={() => setShowRestartModal(true)}
              className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-50 text-orange-600 hover:bg-orange-100 transition-colors flex items-center gap-1"
              title="Crear un nuevo producto"
            >
              <PlusCircle className="w-3 h-3" />
              Nuevo
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                    msg.role === 'user'
                      ? 'bg-orange-600 text-white rounded-tr-sm'
                      : 'bg-white text-neutral-800 rounded-tl-sm border border-neutral-200 shadow-sm'
                  }`}
                >
                  {msg.isSystem && (
                    <div className="flex items-center gap-2 mb-2 text-orange-500 font-medium text-sm">
                      {assets.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={assets.logoUrl} alt="Logo" className="w-4 h-4 rounded-full object-cover" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      <span>CreaMype</span>
                    </div>
                  )}

                  {msg.text && (
                    <div className="prose prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-neutral-100 prose-pre:border prose-pre:border-neutral-200">
                      <ReactMarkdown>{msg.text}</ReactMarkdown>
                    </div>
                  )}

                  {msg.isImage && (msg.imageUrl || msg.imageAssetKey) && (
                    <div className="mt-3 rounded-lg overflow-hidden border border-neutral-200 bg-neutral-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={msg.imageAssetKey ? assets[msg.imageAssetKey] : msg.imageUrl} alt="Generated asset" className="w-full h-auto object-cover" />
                    </div>
                  )}
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {isLoading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-start">
              <div className="bg-white border border-neutral-200 text-neutral-700 shadow-sm rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-3 text-sm">
                <Loader2 size={16} className="animate-spin text-orange-500" />
                <span>{loadingStatus}</span>
              </div>
            </motion.div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 bg-white border-t border-neutral-200">
          <div className="relative flex items-end gap-2">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Escribe tu mensaje aquí..."
              className="w-full bg-neutral-50 border border-neutral-200 text-neutral-900 rounded-xl px-4 py-3 pr-12 focus:outline-none focus:ring-2 focus:ring-orange-500/50 focus:border-orange-500 resize-none min-h-[52px] max-h-32"
              rows={1}
              disabled={isLoading}
            />
            <button
              onClick={handleSend}
              disabled={!inputText.trim() || isLoading}
              className="absolute right-2 bottom-2 p-2 bg-orange-600 hover:bg-orange-500 disabled:bg-neutral-200 disabled:text-neutral-400 text-white rounded-lg transition-colors flex-shrink-0"
            >
              <Send size={18} />
            </button>
          </div>
          <p className="text-center text-[10px] text-neutral-500 mt-2">
            La IA puede cometer errores. Verifica la información importante.
          </p>
        </div>
      </div>

      {/* Right Panel: Brand Dashboard */}
      <div className="hidden md:flex flex-1 flex-col bg-neutral-50 overflow-y-auto">
        <div className="p-8 max-w-4xl mx-auto w-full space-y-10">

          {/* Progress Tracker */}
          <div className="flex items-center justify-between relative">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-0.5 bg-neutral-200 -z-10"></div>
            {steps.map((s) => {
              const isActive = step === s.num;
              const isCompleted = step > s.num;
              const Icon = s.icon;
              return (
                <div key={s.num} className="flex flex-col items-center gap-2 bg-neutral-50 px-2">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors ${
                    isCompleted ? 'bg-orange-600 border-orange-600 text-white' :
                    isActive ? 'bg-white border-orange-500 text-orange-500' :
                    'bg-white border-neutral-200 text-neutral-400'
                  }`}>
                    {isCompleted ? <CheckCircle2 size={18} /> : <Icon size={18} />}
                  </div>
                  <span className={`text-xs font-medium ${isActive || isCompleted ? 'text-neutral-900' : 'text-neutral-500'}`}>
                    {s.title}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Dashboard Content */}
          <div className="space-y-8">

            {/* Step 1: Brand Identity */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: step >= 2 ? 1 : 0.3, y: 0 }}
              className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6"
            >
              <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Sparkles size={16} /> Identidad de Marca
              </h2>
              {assets.name ? (
                <div>
                  <h3 className="text-4xl font-bold tracking-tight text-neutral-900 mb-2">{assets.name}</h3>
                  <p className="text-neutral-600 text-sm leading-relaxed">{assets.profile}</p>
                </div>
              ) : (
                <div className="h-24 flex items-center justify-center text-neutral-500 border border-dashed border-neutral-300 rounded-xl">
                  Esperando definición de marca...
                </div>
              )}
            </motion.div>

            {/* Step 2 & 3: Visual Assets */}
            <div className="grid grid-cols-2 gap-6">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: step >= 3 ? 1 : 0.3, y: 0 }}
                className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6 flex flex-col"
              >
                <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <ImageIcon size={16} /> Logo
                </h2>
                <div className="flex-1 flex items-center justify-center bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden aspect-square relative">
                  {assets.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assets.logoUrl} alt="Logo" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-neutral-500 text-sm">Pendiente</span>
                  )}
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: step >= 4 ? 1 : 0.3, y: 0 }}
                className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6 flex flex-col"
              >
                <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <ImageIcon size={16} /> Etiqueta
                </h2>
                <div className="flex-1 flex items-center justify-center bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden aspect-square relative">
                  {assets.labelUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assets.labelUrl} alt="Label" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-neutral-500 text-sm">Pendiente</span>
                  )}
                </div>
              </motion.div>
            </div>

            {/* Step 4: Landing Page */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: step >= 5 ? 1 : 0.3, y: 0 }}
              className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6"
            >
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-2">
                  <LayoutTemplate size={16} /> Landing Page
                </h2>
                {assets.landingPage && (
                  <button
                    onClick={() => setActiveTab('landing')}
                    className="text-xs font-medium text-orange-600 hover:text-orange-700 flex items-center gap-1 bg-orange-50 px-3 py-1.5 rounded-lg transition-colors"
                  >
                    <Globe size={14} />
                    Ver en pantalla completa
                  </button>
                )}
              </div>
              <div className="bg-white rounded-xl overflow-hidden border border-neutral-200 h-[400px] relative">
                {assets.landingPage ? (
                  <iframe
                    srcDoc={`
                      <!DOCTYPE html>
                      <html>
                        <head>
                          <meta charset="UTF-8">
                          <meta name="viewport" content="width=device-width, initial-scale=1.0">
                          <script src="https://cdn.tailwindcss.com"></script>
                          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
                          <script>
                            tailwind.config = {
                              theme: {
                                extend: {
                                  fontFamily: {
                                    sans: ['Inter', 'sans-serif'],
                                    display: ['Space Grotesk', 'sans-serif'],
                                  }
                                }
                              }
                            }
                          </script>
                          <style>
                            body { font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
                            h1, h2, h3, h4, h5, h6 { font-family: 'Space Grotesk', sans-serif; letter-spacing: -0.02em; }
                          </style>
                        </head>
                        <body class="bg-neutral-50 text-neutral-900">
                          ${assets.landingPage.replace(/LOGO_URL_PLACEHOLDER/g, assets.logoUrl || '').replace(/LABEL_URL_PLACEHOLDER/g, assets.labelUrl || '')}
                        </body>
                      </html>
                    `}
                    className="w-full h-full border-0"
                    title="Landing Page Preview"
                    sandbox="allow-scripts"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-neutral-500 bg-neutral-50">
                    Pendiente
                  </div>
                )}
              </div>
            </motion.div>

            {/* Step 5: Marketing Plan */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: step >= 6 ? 1 : 0.3, y: 0 }}
              className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6"
            >
              <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Megaphone size={16} /> Plan de Marketing
              </h2>
              {assets.marketingPlan ? (
                <div className="prose prose-sm max-w-none bg-neutral-50 p-6 rounded-xl border border-neutral-200">
                  <ReactMarkdown>{assets.marketingPlan}</ReactMarkdown>
                </div>
              ) : (
                <div className="h-32 flex items-center justify-center text-neutral-500 border border-dashed border-neutral-300 rounded-xl">
                  Pendiente
                </div>
              )}
            </motion.div>

          </div>
        </div>
      </div>
      </>
      )}

      {activeTab === 'landing' && (
        <div className="flex-1 overflow-y-auto bg-white">
          {assets.landingPage ? (
            <div className="max-w-5xl mx-auto p-8 h-full flex flex-col">
              <div className="flex items-center justify-between mb-8 pb-4 border-b border-neutral-100 flex-shrink-0">
                <h2 className="text-2xl font-bold text-neutral-900 flex items-center gap-3">
                  <Globe className="w-6 h-6 text-orange-500" />
                  Vista previa de tu Landing Page
                </h2>
                <button
                  onClick={() => setActiveTab('create')}
                  className="px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
                >
                  Volver al editor
                </button>
              </div>
              <div className="flex-1 bg-neutral-100 rounded-2xl overflow-hidden border border-neutral-200">
                <iframe
                  srcDoc={`
                    <!DOCTYPE html>
                    <html>
                      <head>
                        <meta charset="UTF-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <script src="https://cdn.tailwindcss.com"></script>
                        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
                        <script>
                          tailwind.config = {
                            theme: {
                              extend: {
                                fontFamily: {
                                  sans: ['Inter', 'sans-serif'],
                                  display: ['Space Grotesk', 'sans-serif'],
                                }
                              }
                            }
                          }
                        </script>
                        <style>
                          body { font-family: 'Inter', sans-serif; -webkit-font-smoothing: antialiased; }
                          h1, h2, h3, h4, h5, h6 { font-family: 'Space Grotesk', sans-serif; letter-spacing: -0.02em; }
                        </style>
                      </head>
                      <body class="bg-neutral-50 text-neutral-900">
                        ${assets.landingPage.replace(/LOGO_URL_PLACEHOLDER/g, assets.logoUrl || '').replace(/LABEL_URL_PLACEHOLDER/g, assets.labelUrl || '')}
                      </body>
                    </html>
                  `}
                  className="w-full h-full border-0"
                  title="Landing Page Full Preview"
                  sandbox="allow-scripts"
                />
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center">
              <div className="w-20 h-20 bg-orange-50 rounded-full flex items-center justify-center mb-6">
                <Globe className="w-10 h-10 text-orange-500" />
              </div>
              <h2 className="text-2xl font-bold text-neutral-900 mb-3">Aún no hay página web</h2>
              <p className="text-neutral-500 max-w-md mb-8">
                Completa los pasos en el creador de productos para generar tu landing page con inteligencia artificial.
              </p>
              <button
                onClick={() => setActiveTab('create')}
                className="px-6 py-3 bg-orange-600 hover:bg-orange-500 text-white rounded-xl font-medium transition-colors"
              >
                Ir al creador
              </button>
            </div>
          )}
        </div>
      )}

      </div>
    </div>
  );
}
