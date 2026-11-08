'use client';

import React from 'react';
import { motion, AnimatePresence } from 'motion/react';


export function RestartModal({ showRestartModal, setShowRestartModal, handleRestart }: { showRestartModal: boolean; setShowRestartModal: (open: boolean) => void; handleRestart: () => void }) {
  return (
<>
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
              <h3 className="text-lg font-bold text-neutral-900 mb-2">¿Crear una marca nueva?</h3>
              <p className="text-neutral-600 text-sm mb-6">
                Esto creará una marca nueva con su primera conversación. Tu conversación actual seguirá disponible en «Mis conversaciones».
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
                  Sí, crear marca
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>


</>
  );
}
