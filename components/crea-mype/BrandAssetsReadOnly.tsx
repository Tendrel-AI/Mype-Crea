import React from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { conversationHref } from './ConversationMenu';

export const MISSING_ASSET_COPY = 'Aún no lo has creado';
export const BRAND_CHAT_LABEL = 'Ir al chat de la marca';

export interface ReadOnlyBrandAssets {
  readonly logoUrl: string | null;
  readonly name: string | null;
  readonly tagline: string | null;
}

const buttonClass = 'inline-block text-sm font-medium text-orange-600 bg-orange-50 hover:bg-orange-100 px-4 py-2 rounded-lg transition-colors';

/** D34: the brand's approved assets in a product conversation. Read-only: they are made in the brand chat. */
export function BrandAssetsReadOnly({ assets, brandConversationId }: {
  assets: ReadOnlyBrandAssets | null;
  /** The brand's single conversation (D40); a plain link, the server re-checks ownership. Hidden when unknown. */
  brandConversationId: string | null;
}) {
  const missing = <span className="text-neutral-500 text-sm">{MISSING_ASSET_COPY}</span>;
  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">Los recursos de tu marca se crean en el chat de la marca.</p>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <h3 className="text-xs font-semibold text-neutral-500 uppercase mb-2 flex items-center gap-1"><ImageIcon size={14} /> Logo</h3>
          <div className="flex items-center justify-center bg-neutral-50 rounded-xl border border-neutral-200 overflow-hidden aspect-square">
            {assets?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={assets.logoUrl} alt="Logo" className="w-full h-full object-cover" />
            ) : missing}
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-semibold text-neutral-500 uppercase mb-1">Nombre</h3>
            {assets?.name ? <p className="text-xl font-bold text-neutral-900">{assets.name}</p> : missing}
          </div>
          <div>
            <h3 className="text-xs font-semibold text-neutral-500 uppercase mb-1">Lema</h3>
            {assets?.tagline ? <p className="text-neutral-800">{assets.tagline}</p> : missing}
          </div>
        </div>
      </div>
      {brandConversationId && <a href={conversationHref(brandConversationId)} className={buttonClass}>{BRAND_CHAT_LABEL}</a>}
    </div>
  );
}
