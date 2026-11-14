import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SocialCard } from '../social-card';
import { ChatPanel } from '../ChatPanel';
import { PHOTO_UPLOAD_LABEL } from '../lab-upload-copy';
import type { DeliverableStateView } from '../../../src/core/contracts';
import type { BrandAssets, Message } from '../types';

const noop = () => {};
const view = (partial: Partial<DeliverableStateView>): DeliverableStateView => ({
  agentId: 'social-agent', deliverableKind: 'social_pack', state: 'enabled', stale: false, allowedCommands: ['generate'],
  missingFields: [], missingUpstream: [], activeTask: null, lastFailure: null, candidates: [],
  approvedDeliverableId: null, stateToken: 'ds1-00000000', ...partial,
}) as DeliverableStateView;

describe('SocialCard', () => {
  it('shows the optional-photo note when there are no photos', () => {
    const markup = renderToStaticMarkup(<SocialCard view={view({})} photos={[]} uploading={false} busy={false} error="" onCommand={noop} />);
    expect(markup).toContain('sube una foto real de tu producto');
  });

  it('lists photo names, the uploading status and forwards the commands', () => {
    const markup = renderToStaticMarkup(
      <SocialCard view={view({})} photos={[{ id: 'a', name: 'frasco.png' }]} uploading busy={false} error="" onCommand={noop} />,
    );
    expect(markup).toContain('frasco.png');
    expect(markup).toContain('Subiendo la foto');
    expect(markup).toContain('Generar');
  });
});

describe('ChatPanel photo button', () => {
  const assets: BrandAssets = { name: '', profile: '', logoUrl: '', labelUrl: '', landingPage: '', marketingPlan: '' };
  const chat = {
    assets, processingAgents: new Set<string>(), conversationId: 'c1', handleExportConversation: noop, onCreateBrand: noop, onImportBrand: noop,
    messages: [] as Message[], isLoading: false, messagesEndRef: React.createRef<HTMLDivElement>(), conversationError: '', retryTurn: null,
    submitTurn: noop, inputText: '', setInputText: noop, handleKeyDown: noop, handleSend: noop, needsNewConversation: false,
  };

  it('exists only when given photoUpload', () => {
    expect(renderToStaticMarkup(<ChatPanel {...chat} />)).not.toContain(PHOTO_UPLOAD_LABEL);
    const product = renderToStaticMarkup(<ChatPanel {...chat} photoUpload={{ busy: false, onFiles: noop }} />);
    expect(product).toContain(`aria-label="${PHOTO_UPLOAD_LABEL}"`);
    expect(product).toContain('image/png,image/jpeg,image/webp,image/svg+xml');
  });
});
