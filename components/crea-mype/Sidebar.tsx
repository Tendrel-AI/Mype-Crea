'use client';

import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Loader2, Sparkles, Menu, Globe, PlusCircle } from 'lucide-react';
import { signOutAction } from '../../app/actions/auth';
import { type BrandAssets, type Tab } from './types';


export function Sidebar({ activeTab, setActiveTab, isSidebarOpen, setIsSidebarOpen, assets, processingAgents, userEmail, userName }: { activeTab: Tab; setActiveTab: (tab: Tab) => void; isSidebarOpen: boolean; setIsSidebarOpen: (open: boolean) => void; assets: BrandAssets; processingAgents: Set<string>; userEmail: string; userName: string }) {
  return (
<>
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
                ) : processingAgents.has('logo-agent') ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
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


</>
  );
}
