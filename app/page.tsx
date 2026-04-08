'use client';

import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import ReactMarkdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Loader2, Sparkles, Image as ImageIcon, LayoutTemplate, Megaphone, CheckCircle2, LogOut, Menu, Package, Globe, PlusCircle, ChevronLeft, ChevronRight, Grid } from 'lucide-react';
import { generateImageAction } from './actions';
import { useFirebaseSession } from '../hooks/useFirebaseSession';

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

export default function CreaMype() {
  const { user, isAuthReady, login, logout, saveSession, loadSession, loadAllSessions, sessionId, setSessionId } = useFirebaseSession();
  
  const [activeTab, setActiveTab] = useState<'create' | 'gallery' | 'landing'>('create');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [allSessions, setAllSessions] = useState<any[]>([]);

  const [step, setStep] = useState<Step>(1);
  const [assets, setAssets] = useState<BrandAssets>({
    name: '',
    profile: '',
    logoUrl: '',
    labelUrl: '',
    landingPage: '',
    marketingPlan: '',
  });
  
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 'welcome',
      role: 'model',
      text: '¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.\n\n**Paso 1: Nombre del Negocio**\nPara empezar, cuéntame un poco sobre tu idea: ¿En qué industria estás? ¿Cuáles son tus valores principales? ¿A quién va dirigido tu producto?',
      isSystem: true,
    }
  ]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<string>('');
  const [isSessionLoaded, setIsSessionLoaded] = useState(false);
  const [showRestartModal, setShowRestartModal] = useState(false);
  
  // We keep the raw history for the Gemini API
  const [chatHistory, setChatHistory] = useState<any[]>([]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load session when user logs in
  useEffect(() => {
    if (user && isAuthReady) {
      setIsSessionLoaded(false);
      loadSession().then(data => {
        if (data) {
          if (data.step) setStep(data.step);
          if (data.assets) setAssets(data.assets);
          if (data.messages) setMessages(data.messages);
          if (data.chatHistory) setChatHistory(data.chatHistory);
        } else {
          // Reset state for new users
          setStep(1);
          setAssets({
            name: '',
            profile: '',
            logoUrl: '',
            labelUrl: '',
            landingPage: '',
            marketingPlan: '',
          });
          setMessages([
            {
              id: 'welcome',
              role: 'model',
              text: '¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.\n\n**Paso 1: Nombre del Negocio**\nPara empezar, cuéntame un poco sobre tu idea: ¿En qué industria estás? ¿Cuáles son tus valores principales? ¿A quién va dirigido tu producto?',
              isSystem: true,
            }
          ]);
          setChatHistory([]);
        }
        setIsSessionLoaded(true);
      });
      
      loadAllSessions().then(sessions => {
        setAllSessions(sessions);
      });
    } else if (!user && isAuthReady) {
      // Reset state when user logs out
      setIsSessionLoaded(false);
      setStep(1);
      setAssets({
        name: '',
        profile: '',
        logoUrl: '',
        labelUrl: '',
        landingPage: '',
        marketingPlan: '',
      });
      setMessages([
        {
          id: 'welcome',
          role: 'model',
          text: '¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.\n\n**Paso 1: Nombre del Negocio**\nPara empezar, cuéntame un poco sobre tu idea: ¿En qué industria estás? ¿Cuáles son tus valores principales? ¿A quién va dirigido tu producto?',
          isSystem: true,
        }
      ]);
      setChatHistory([]);
    }
  }, [user, isAuthReady, loadSession, loadAllSessions]);

  // Save session whenever state changes
  useEffect(() => {
    if (user && isAuthReady && isSessionLoaded && messages.length > 1) {
      saveSession({
        step,
        assets,
        messages,
        chatHistory
      });
    }
  }, [step, assets, messages, chatHistory, user, isAuthReady, isSessionLoaded, saveSession]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const tools = [
    {
      functionDeclarations: [
        {
          name: 'finalize_name',
          description: 'Guarda el nombre del negocio y el perfil, avanzando al Paso 2 (Logo). Usa esta herramienta SOLO cuando el usuario haya aprobado explícitamente un nombre.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              business_name: { type: Type.STRING },
              business_profile: { type: Type.STRING, description: 'Resumen de industria, audiencia, valores' }
            },
            required: ['business_name', 'business_profile']
          }
        },
        {
          name: 'generate_logo',
          description: 'Genera un logo basado en un prompt detallado en inglés, avanzando al Paso 3 (Etiqueta). Usa esta herramienta SOLO cuando el usuario haya aprobado un estilo de logo.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              image_prompt: { type: Type.STRING, description: 'Prompt altamente detallado en inglés para generar el logo (estilo, colores, tipografía, etc.)' }
            },
            required: ['image_prompt']
          }
        },
        {
          name: 'generate_label',
          description: 'Genera una etiqueta de producto basada en un prompt detallado en inglés, avanzando al Paso 4 (Landing Page). Usa esta herramienta SOLO cuando el usuario haya aprobado el concepto de la etiqueta.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              image_prompt: { type: Type.STRING, description: 'Prompt altamente detallado en inglés para generar la etiqueta del producto' }
            },
            required: ['image_prompt']
          }
        },
        {
          name: 'finalize_landing_page',
          description: 'Guarda el código HTML de la landing page con Tailwind CSS, avanzando al Paso 5 (Marketing). Usa esta herramienta para generar la web final.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              html_content: { type: Type.STRING, description: 'Código HTML de la landing page usando clases de Tailwind CSS. IMPORTANTE: El diseño debe ser ultra-moderno (año 2026), premium y minimalista. Usa mucho espacio en blanco (py-24), tipografía grande y elegante (tracking-tight), bordes muy redondeados (rounded-3xl), efectos de cristal (backdrop-blur, bg-white/10), sombras suaves (shadow-2xl), y gradientes modernos. Evita diseños anticuados o genéricos. En el header/nav, usa el logo (LOGO_URL_PLACEHOLDER) en lugar de un icono de estrella o texto genérico. Puedes usar un icono de estrella para el favicon si quieres. Devuelve SOLO el contenido interior del <body> (nav, header, main, footer). NO incluyas las etiquetas <html>, <head>, <body> ni <!DOCTYPE html>. NO uses bloques de código markdown (```html).' }
            },
            required: ['html_content']
          }
        },
        {
          name: 'finalize_marketing',
          description: 'Guarda el plan de marketing en formato Markdown, completando el flujo.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              markdown_content: { type: Type.STRING, description: 'Plan de marketing detallado en Markdown (redes sociales, email, contenido, publicidad pagada)' }
            },
            required: ['markdown_content']
          }
        },
        {
          name: 'edit_logo',
          description: 'Edita el logo actual usando un nuevo prompt en inglés. Usa esta herramienta cuando el usuario pida cambios en el logo generado.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              image_prompt: { type: Type.STRING, description: 'Prompt detallado en inglés para modificar el logo actual.' }
            },
            required: ['image_prompt']
          }
        },
        {
          name: 'edit_label',
          description: 'Edita la etiqueta actual usando un nuevo prompt en inglés. Usa esta herramienta cuando el usuario pida cambios en la etiqueta generada.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              image_prompt: { type: Type.STRING, description: 'Prompt detallado en inglés para modificar la etiqueta actual.' }
            },
            required: ['image_prompt']
          }
        },
        {
          name: 'edit_landing_page',
          description: 'Edita el código HTML de la landing page. Usa esta herramienta cuando el usuario pida cambios en la página web.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              html_content: { type: Type.STRING, description: 'El nuevo código HTML de la landing page con los cambios aplicados. IMPORTANTE: Mantén un diseño ultra-moderno (año 2026), premium y minimalista. Usa mucho espacio en blanco (py-24), tipografía grande y elegante (tracking-tight), bordes muy redondeados (rounded-3xl), efectos de cristal (backdrop-blur, bg-white/10), sombras suaves (shadow-2xl), y gradientes modernos. En el header/nav, usa el logo (LOGO_URL_PLACEHOLDER) en lugar de un icono de estrella o texto genérico. Puedes usar un icono de estrella para el favicon si quieres. Devuelve SOLO el contenido interior del <body> (nav, header, main, footer). NO incluyas las etiquetas <html>, <head>, <body> ni <!DOCTYPE html>. NO uses bloques de código markdown (```html).' }
            },
            required: ['html_content']
          }
        },
        {
          name: 'edit_marketing_plan',
          description: 'Edita el plan de marketing en Markdown. Usa esta herramienta cuando el usuario pida cambios en la campaña o plan de marketing.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              markdown_content: { type: Type.STRING, description: 'El nuevo plan de marketing completo en Markdown con los cambios aplicados.' }
            },
            required: ['markdown_content']
          }
        }
      ]
    }
  ];

  const getSystemInstruction = (currentStep: Step, currentAssets: BrandAssets) => {
    return `Eres 'CreaMype', un experto estratega de marca y diseñador. Tu objetivo es guiar al usuario a través de 5 pasos para crear su marca y lanzar su producto.
    
    Paso actual: ${currentStep}.
    Activos actuales: ${JSON.stringify(currentAssets)}.
    
    Reglas estrictas:
    - Habla siempre en español.
    - Sé proactivo, creativo y profesional.
    - NO uses una herramienta de avance (finalize_name, generate_logo, etc.) hasta que el usuario haya confirmado su elección para ese paso.
    - Si el usuario pide cambios en algo ya generado (logo, etiqueta, web, marketing), DEBES usar las herramientas de edición correspondientes (edit_logo, edit_label, edit_landing_page, edit_marketing_plan).
    - Tienes el contexto completo de los activos actuales en 'Activos actuales'. Úsalos para mantener la coherencia.
    
    Guía por pasos:
    - Paso 1 (Nombre): Pregunta sobre la industria, valores, audiencia. Sugiere 3-5 nombres con justificación. Cuando el usuario elija uno, usa 'finalize_name'.
    - Paso 2 (Logo): Pregunta sobre el estilo del logo (minimalista, ilustrativo, tipográfico, etc.). Cuando el usuario elija, usa 'generate_logo' con un prompt en inglés muy detallado.
    - Paso 3 (Etiqueta): Pregunta sobre los detalles del producto para la etiqueta. Usa 'generate_label' con un prompt en inglés muy detallado. El sistema usará el logo generado previamente como referencia visual para mantener la coherencia.
    - Paso 4 (Landing Page): Escribe el copy persuasivo y diseña una landing page en HTML con Tailwind CSS. El diseño DEBE ser de vanguardia (año 2026): estilo premium, con mucho espacio en blanco (py-24), tipografías enormes y audaces (tracking-tight), bento grids, efectos glassmorphism (backdrop-blur) y bordes muy redondeados (rounded-3xl). Evita diseños aburridos o genéricos de los 2010s. Usa 'finalize_landing_page'. MUY IMPORTANTE: Para mostrar el logo y la etiqueta en el HTML, usa exactamente los textos "LOGO_URL_PLACEHOLDER" y "LABEL_URL_PLACEHOLDER" en los atributos src de las etiquetas <img>. En el header/nav, usa el logo (LOGO_URL_PLACEHOLDER) en lugar de un icono de estrella o texto genérico. Puedes usar un icono de estrella para el favicon si quieres. El sistema los reemplazará automáticamente con las imágenes reales. Asegúrate de generar el HTML detallado pero SOLO el contenido del <body>.
    - Paso 5 (Marketing): Crea un plan de marketing multicanal en Markdown. Usa 'finalize_marketing'.
    
    Edición:
    - Si el usuario dice "cambia el color del logo a azul", usa 'edit_logo'.
    - Si el usuario dice "agrega una sección de testimonios a la web", usa 'edit_landing_page' y reescribe el HTML (SOLO el contenido del <body>).
    - Si el usuario dice "haz el plan de marketing más enfocado en TikTok", usa 'edit_marketing_plan'.`;
  };

  const handleSend = async () => {
    if (!inputText.trim()) return;

    const userText = inputText.trim();
    setInputText('');
    
    const newUserMsg: Message = { id: Date.now().toString(), role: 'user', text: userText };
    setMessages(prev => [...prev, newUserMsg]);
    
    const newHistory = [...chatHistory, { role: 'user', parts: [{ text: userText }] }];
    
    setIsLoading(true);
    setLoadingStatus('Analizando...');

    let currentLogoUrl = assets.logoUrl;
    let currentLabelUrl = assets.labelUrl;
    let currentStep = step;
    let currentAssets = { ...assets };

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      let currentHistory = [...newHistory];
      let keepProcessing = true;
      let retryCount = 0;
      let loopCount = 0;
      const MAX_RETRIES = 3;
      const MAX_LOOPS = 10;
      
      while (keepProcessing) {
        loopCount++;
        if (loopCount > MAX_LOOPS) {
          throw new Error("La IA se ha atascado intentando realizar la tarea. Por favor, intenta de nuevo con instrucciones más simples.");
        }
        
        let response;
        try {
          response = await ai.models.generateContent({
            model: 'gemini-3.1-pro-preview',
            contents: currentHistory,
            config: {
              systemInstruction: getSystemInstruction(currentStep, currentAssets),
              tools: tools as any,
              temperature: 0.7,
              maxOutputTokens: 8192,
            }
          });
          retryCount = 0; // Reset retries on successful API call
        } catch (apiError: any) {
          console.error("API Error during generateContent:", apiError);
          if (retryCount < MAX_RETRIES) {
            retryCount++;
            setLoadingStatus('Uy, la IA está trabajando duro, va a tomar unos segundos más. Espérame...');
            // Append a hint to the last user message's parts to preserve alternating roles
            const lastMessage = currentHistory[currentHistory.length - 1];
            if (lastMessage && lastMessage.role === 'user') {
              lastMessage.parts.push({ text: `\n\n[Sistema: Hubo un error técnico al generar tu respuesta anterior. Por favor, intenta de nuevo. Asegúrate de escapar correctamente las comillas y NO usar bloques de markdown (\`\`\`html). Error: ${apiError.message}]` });
            }
            continue; // Retry the API call
          } else {
            throw new Error("Demasiados reintentos fallidos por errores de formato de la IA.");
          }
        }

        const responseContent = response.candidates?.[0]?.content;
        if (!responseContent) throw new Error("Sin respuesta del modelo");
        
        currentHistory.push(responseContent);

        const functionCalls = response.functionCalls;
        
        if (functionCalls && functionCalls.length > 0) {
          const call = functionCalls[0];
          const args = call.args as any;
          let functionResponseData: any = { success: true };
          
          try {
            if (call.name === 'finalize_name') {
              setLoadingStatus('Guardando perfil de negocio...');
              currentAssets.name = args.business_name;
              currentAssets.profile = args.business_profile;
              currentStep = 2;
              setAssets(prev => ({ ...prev, name: args.business_name, profile: args.business_profile }));
              setStep(2);
              functionResponseData = { message: "Nombre guardado exitosamente. Avanzando al Paso 2." };
            } 
            else if (call.name === 'generate_logo') {
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
            else if (call.name === 'generate_label') {
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
            else if (call.name === 'finalize_landing_page' || call.name === 'edit_landing_page') {
              setLoadingStatus(call.name === 'finalize_landing_page' ? 'Construyendo landing page...' : 'Actualizando landing page...');
              let htmlContent = cleanHtmlContent(args.html_content);
              
              // Validate HTML to ensure it's not broken or empty
              if (!htmlContent || htmlContent.length < 150 || !htmlContent.includes('<div') || !htmlContent.includes('class=')) {
                throw new Error("El HTML generado es inválido, está incompleto o no usa Tailwind CSS. Por favor, genera el código HTML completo y detallado (solo el contenido del <body>) usando clases de Tailwind CSS. No uses markdown.");
              }

              currentAssets.landingPage = htmlContent;
              setAssets(prev => ({ ...prev, landingPage: htmlContent }));
              
              if (call.name === 'finalize_landing_page') {
                currentStep = 5;
                setStep(5);
                functionResponseData = { message: "Landing page guardada exitosamente. Avanzando al Paso 5." };
              } else {
                functionResponseData = { message: "Landing page actualizada exitosamente." };
              }
            }
            else if (call.name === 'finalize_marketing') {
              setLoadingStatus('Finalizando plan de marketing...');
              currentAssets.marketingPlan = args.markdown_content;
              currentStep = 6;
              setAssets(prev => ({ ...prev, marketingPlan: args.markdown_content }));
              setStep(6);
              functionResponseData = { message: "Plan de marketing guardado exitosamente. Flujo completado." };
            }
            else if (call.name === 'edit_logo') {
              setLoadingStatus('Editando logo con IA...');
              const imageUrl = await generateImageAction(args.image_prompt, currentLogoUrl);
              currentLogoUrl = imageUrl;
              currentAssets.logoUrl = imageUrl;
              setAssets(prev => ({ ...prev, logoUrl: imageUrl }));
              setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Aquí tienes el logo actualizado:', isImage: true, imageAssetKey: 'logoUrl' }]);
              functionResponseData = { message: "Logo editado y actualizado exitosamente." };
            }
            else if (call.name === 'edit_label') {
              setLoadingStatus('Editando etiqueta con IA...');
              const imageUrl = await generateImageAction(args.image_prompt, currentLabelUrl);
              currentLabelUrl = imageUrl;
              currentAssets.labelUrl = imageUrl;
              setAssets(prev => ({ ...prev, labelUrl: imageUrl }));
              setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Aquí tienes la etiqueta actualizada:', isImage: true, imageAssetKey: 'labelUrl' }]);
              functionResponseData = { message: "Etiqueta editada y actualizada exitosamente." };
            }
            else if (call.name === 'edit_marketing_plan') {
              setLoadingStatus('Actualizando plan de marketing...');
              currentAssets.marketingPlan = args.markdown_content;
              setAssets(prev => ({ ...prev, marketingPlan: args.markdown_content }));
              functionResponseData = { message: "Plan de marketing actualizado exitosamente." };
            }
          } catch (err: any) {
            console.error("Error executing tool:", err);
            functionResponseData = { success: false, error: err.message };
            
            // Show friendly message if the tool failed (e.g. HTML validation failed)
            if (call.name === 'finalize_landing_page' || call.name === 'edit_landing_page') {
              setLoadingStatus('Uy, la IA está trabajando duro, va a tomar unos segundos más. Espérame...');
            }
          }

          // Append function response to history
          currentHistory.push({
            role: 'user',
            parts: [{
              functionResponse: {
                name: call.name,
                response: functionResponseData
              }
            }]
          });
          
          // Loop continues to get the text response acknowledging the tool execution
          if (functionResponseData.success) {
            setLoadingStatus('Escribiendo respuesta...');
          }
        } else {
          // No function call, just a text response
          let text = '';
          try {
            text = response.text || '';
          } catch (e) {
            console.warn("Error reading response.text:", e);
          }
          
          if (text) {
            setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text }]);
          } else {
            setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Lo siento, no pude generar una respuesta clara. ¿Podrías reformular tu petición?' }]);
          }
          keepProcessing = false;
        }
      }
      
      setChatHistory(currentHistory);
      
    } catch (error: any) {
      console.error("Chat error:", error);
      if (error.message?.includes('CUSTOM_GEMINI_API_KEY')) {
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'model', text: 'Error: La clave CUSTOM_GEMINI_API_KEY no está configurada. Por favor, añádela en el menú de Secrets de AI Studio.' }]);
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

  const steps = [
    { num: 1, title: 'Nombre', icon: Sparkles },
    { num: 2, title: 'Logo', icon: ImageIcon },
    { num: 3, title: 'Etiqueta', icon: ImageIcon },
    { num: 4, title: 'Web', icon: LayoutTemplate },
    { num: 5, title: 'Marketing', icon: Megaphone },
  ];

  if (!isAuthReady) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 text-neutral-900 font-sans">
        <Loader2 className="w-8 h-8 animate-spin text-orange-500" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-50 text-neutral-900 font-sans">
        <div className="text-center space-y-6 p-10 max-w-md bg-white rounded-3xl border border-neutral-200 shadow-xl">
          <div className="bg-orange-500/10 w-20 h-20 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <Sparkles className="w-10 h-10 text-orange-400" />
          </div>
          <h1 className="text-3xl font-bold tracking-tight">CreaMype</h1>
          <p className="text-neutral-600 text-sm leading-relaxed">
            Inicia sesión para crear tu marca, generar logos, etiquetas y páginas web con Inteligencia Artificial. Tu progreso se guardará automáticamente.
          </p>
          <button
            onClick={login}
            className="w-full px-6 py-4 bg-orange-600 hover:bg-orange-500 text-white rounded-xl font-medium transition-all transform hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-orange-500/25"
          >
            Iniciar sesión con Google
          </button>
        </div>
      </div>
    );
  }

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
            onClick={() => {
              setActiveTab('gallery');
              loadAllSessions().then(sessions => setAllSessions(sessions));
            }}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${activeTab === 'gallery' ? 'bg-orange-50 text-orange-600' : 'hover:bg-neutral-100 text-neutral-600'}`}
            title="Tus productos creados"
          >
            <Package className="w-5 h-5 flex-shrink-0" />
            <span className={`font-medium whitespace-nowrap transition-opacity ${isSidebarOpen ? 'opacity-100' : 'opacity-0 hidden'}`}>
              Tus productos
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
        
        <div className="p-4 border-t border-neutral-100">
          <button 
            onClick={logout} 
            className="flex items-center gap-3 px-3 py-2.5 w-full rounded-xl hover:bg-neutral-100 text-neutral-500 transition-colors"
            title="Cerrar sesión"
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            <span className={`font-medium whitespace-nowrap transition-opacity ${isSidebarOpen ? 'opacity-100' : 'opacity-0 hidden'}`}>
              Cerrar sesión
            </span>
          </button>
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
                Esto iniciará un nuevo proceso de creación. Tu producto actual se guardará en &quot;Tus productos creados&quot;.
              </p>
              <div className="flex justify-end gap-3">
                <button 
                  onClick={() => setShowRestartModal(false)}
                  className="px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-lg transition-colors"
                >
                  Cancelar
                </button>
                <button 
                  onClick={() => {
                    setSessionId(Date.now().toString());
                    setStep(1);
                    setAssets({ name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' });
                    setMessages([{
                      id: 'welcome',
                      role: 'model',
                      text: '¡Hola! Soy tu estratega de marca y diseñador de IA. Vamos a crear tu marca y lanzar tu producto en 5 pasos.\n\n**Paso 1: Nombre del Negocio**\nPara empezar, cuéntame un poco sobre tu idea: ¿En qué industria estás? ¿Cuáles son tus valores principales? ¿A quién va dirigido tu producto?',
                      isSystem: true,
                    }]);
                    setChatHistory([]);
                    setShowRestartModal(false);
                  }}
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
            <button onClick={logout} className="text-neutral-500 hover:text-neutral-900 transition-colors" title="Cerrar sesión">
              <LogOut className="w-4 h-4" />
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
            {steps.map((s, i) => {
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

      {activeTab === 'gallery' && (
        <div className="flex-1 overflow-y-auto p-8 bg-neutral-50">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-3xl font-bold text-neutral-900 mb-8 flex items-center gap-3">
              <Package className="w-8 h-8 text-orange-500" />
              Tus productos creados
            </h2>
            
            {allSessions.length === 0 ? (
              <div className="text-center py-20 bg-white rounded-2xl border border-neutral-200">
                <Package className="w-16 h-16 text-neutral-300 mx-auto mb-4" />
                <h3 className="text-xl font-medium text-neutral-900 mb-2">Aún no tienes productos</h3>
                <p className="text-neutral-500 mb-6">Crea tu primer producto usando la inteligencia artificial.</p>
                <button 
                  onClick={() => setActiveTab('create')}
                  className="px-6 py-3 bg-orange-600 hover:bg-orange-500 text-white rounded-xl font-medium transition-colors"
                >
                  Crear mi primer producto
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {allSessions.map((session) => (
                  <div key={session.id} className="bg-white rounded-2xl border border-neutral-200 overflow-hidden hover:shadow-lg transition-shadow group">
                    <div className="aspect-video bg-neutral-100 relative overflow-hidden border-b border-neutral-100">
                      {session.assets?.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={session.assets.logoUrl} alt="Logo" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-neutral-400">
                          <ImageIcon className="w-10 h-10" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-3">
                        <button 
                          onClick={() => {
                            setSessionId(session.id);
                            setStep(session.step || 1);
                            setAssets(session.assets || { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' });
                            setMessages(session.messages || []);
                            setChatHistory(session.chatHistory || []);
                            setActiveTab('create');
                          }}
                          className="px-4 py-2 bg-white text-neutral-900 rounded-lg font-medium text-sm hover:bg-neutral-100 transition-colors"
                        >
                          Continuar edición
                        </button>
                      </div>
                    </div>
                    <div className="p-5">
                      <h3 className="font-bold text-lg text-neutral-900 mb-1 truncate">
                        {session.assets?.name || 'Producto sin nombre'}
                      </h3>
                      <p className="text-sm text-neutral-500 mb-4 line-clamp-2">
                        {session.assets?.profile || 'Sin descripción'}
                      </p>
                      <div className="flex items-center justify-between text-xs text-neutral-400">
                        <span>Paso {session.step || 1} de 5</span>
                        <span>{new Date(session.updatedAt?.toDate() || Date.now()).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
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
