'use client';

import React from 'react';
import { Globe } from 'lucide-react';
import { type BrandAssets, type Tab } from './types';
import { LandingPageRenderer } from './LandingPageRenderer';


export function LandingPreview({ assets, setActiveTab }: { assets: BrandAssets; setActiveTab: (tab: Tab) => void }) {
  const landingContent = assets.typedLandingPage ?? assets.landingPage;
  const hasLandingPage = Boolean(assets.typedLandingPage || assets.landingPage);
  return (
<>
        <div className="flex-1 overflow-y-auto bg-white">
          {hasLandingPage ? (
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
                <LandingPageRenderer
                  content={landingContent}
                  logoUrl={assets.logoUrl}
                  labelUrl={assets.labelUrl}
                  className="w-full h-full border-0"
                  title="Landing Page Full Preview"
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
</>
  );
}
