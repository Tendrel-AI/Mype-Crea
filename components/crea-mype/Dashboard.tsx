'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import { motion } from 'motion/react';
import { Loader2, Sparkles, Image as ImageIcon, LayoutTemplate, Megaphone, CheckCircle2, Globe } from 'lucide-react';
import { type BrandAssets, type Tab } from './types';
import { LandingPageRenderer } from './LandingPageRenderer';


export function Dashboard({ assets, processingAgents, step, setActiveTab, logoControls }: {
  assets: BrandAssets;
  processingAgents: Set<string>;
  step: number;
  setActiveTab: (tab: Tab) => void;
  /** KAN-28: server-derived logo state and command buttons (DeliverableCommands). */
  logoControls?: React.ReactNode;
}) {
  const landingContent = assets.typedLandingPage ?? assets.landingPage;
  const hasLandingPage = Boolean(assets.typedLandingPage || assets.landingPage);
  const steps = [
    { num: 1, title: 'Nombre', icon: Sparkles },
    { num: 2, title: 'Logo', icon: ImageIcon },
    { num: 3, title: 'Etiqueta', icon: ImageIcon },
    { num: 4, title: 'Web', icon: LayoutTemplate },
    { num: 5, title: 'Marketing', icon: Megaphone },
  ];

  return (
<>
      {/* Right Panel: Brand Dashboard */}
      <div className="hidden md:flex flex-1 flex-col bg-neutral-50 overflow-y-auto">
        <div className="p-8 max-w-4xl mx-auto w-full space-y-10">

          {/* Progress Tracker — clickable; scrolls the right panel to the matching section. */}
          <div className="flex items-center justify-between relative">
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-0.5 bg-neutral-200 -z-10"></div>
            {steps.map((s) => {
              const isActive = step === s.num;
              const isCompleted = step > s.num;
              const Icon = s.icon;
              return (
                <button
                  key={s.num}
                  type="button"
                  onClick={() => {
                    const el = document.getElementById(`brand-step-${s.num}`);
                    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className="flex flex-col items-center gap-2 bg-neutral-50 px-2 cursor-pointer group focus:outline-none"
                  title={`Ir a: ${s.title}`}
                >
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors group-hover:border-orange-400 ${
                    isCompleted ? 'bg-orange-600 border-orange-600 text-white' :
                    isActive ? 'bg-white border-orange-500 text-orange-500' :
                    'bg-white border-neutral-200 text-neutral-400 group-hover:text-orange-500'
                  }`}>
                    {isCompleted ? <CheckCircle2 size={18} /> : <Icon size={18} />}
                  </div>
                  <span className={`text-xs font-medium group-hover:text-orange-600 ${isActive || isCompleted ? 'text-neutral-900' : 'text-neutral-500'}`}>
                    {s.title}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Dashboard Content */}
          <div className="space-y-8">

            {/* Step 1: Brand Identity */}
            <motion.div
              id="brand-step-1"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6 scroll-mt-4"
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
            <div id="brand-step-2" className="grid grid-cols-2 gap-6 scroll-mt-4">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6 flex flex-col"
              >
                <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <ImageIcon size={16} /> Logo
                </h2>
                <div className="flex-1 flex items-center justify-center bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden aspect-square relative">
                  {assets.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assets.logoUrl} alt="Logo" className="w-full h-full object-cover" />
                  ) : processingAgents.has('logo-agent') ? (
                    <div className="flex flex-col items-center gap-2 text-orange-500">
                      <Loader2 size={28} className="animate-spin" />
                      <span className="text-xs text-neutral-500">Generando logo...</span>
                    </div>
                  ) : (
                    <span className="text-neutral-500 text-sm">Pendiente</span>
                  )}
                </div>
                {logoControls}
              </motion.div>

              <motion.div
                id="brand-step-3"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6 flex flex-col scroll-mt-4"
              >
                <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <ImageIcon size={16} /> Etiqueta
                </h2>
                <div className="flex-1 flex items-center justify-center bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden aspect-square relative">
                  {assets.labelUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={assets.labelUrl} alt="Label" className="w-full h-full object-cover" />
                  ) : processingAgents.has('label-agent') ? (
                    <div className="flex flex-col items-center gap-2 text-orange-500">
                      <Loader2 size={28} className="animate-spin" />
                      <span className="text-xs text-neutral-500">Generando etiqueta...</span>
                    </div>
                  ) : (
                    <span className="text-neutral-500 text-sm">Pendiente</span>
                  )}
                </div>
              </motion.div>
            </div>

            {/* Step 4: Landing Page */}
            <motion.div
              id="brand-step-4"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6 scroll-mt-4"
            >
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-sm font-semibold text-neutral-500 uppercase tracking-wider flex items-center gap-2">
                  <LayoutTemplate size={16} /> Landing Page
                </h2>
                {hasLandingPage && (
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
                {hasLandingPage ? (
                  <LandingPageRenderer
                    content={landingContent}
                    logoUrl={assets.logoUrl}
                    labelUrl={assets.labelUrl}
                    className="w-full h-full border-0"
                    title="Landing Page Preview"
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
              id="brand-step-5"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="bg-white border border-neutral-200 shadow-sm rounded-2xl p-6 scroll-mt-4"
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
  );
}
