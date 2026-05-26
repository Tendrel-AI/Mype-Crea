/**
 * Unit tests for InProcessArtifactNotifier. Verifies subscribe/publish
 * fan-out, conversation-scoping, dispose semantics, and that publishing for
 * an unsubscribed conversation is a silent no-op.
 */
import { describe, expect, it, vi } from 'vitest';

import { InProcessArtifactNotifier, type ArtifactPublishedEvent } from '../artifact-notifier';

const conversationA = '00000000-0000-0000-0000-000000000aaa';
const conversationB = '00000000-0000-0000-0000-000000000bbb';

function event(conversationId: string, url: string): ArtifactPublishedEvent {
  return {
    conversationId,
    agentId: 'logo-agent',
    taskId: '11111111-1111-1111-1111-111111111111' as ArtifactPublishedEvent['taskId'],
    artifacts: [{ kind: 'image', url }],
  };
}

describe('InProcessArtifactNotifier', () => {
  it('delivers a published event to a subscriber on the same conversation', () => {
    const notifier = new InProcessArtifactNotifier();
    const seen = vi.fn();
    notifier.subscribe(conversationA, seen);
    notifier.publish(event(conversationA, 'https://x/y.png'));
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ artifacts: [{ kind: 'image', url: 'https://x/y.png' }] }));
  });

  it('does not deliver an event from one conversation to a subscriber of another', () => {
    const notifier = new InProcessArtifactNotifier();
    const seenA = vi.fn();
    notifier.subscribe(conversationA, seenA);
    notifier.publish(event(conversationB, 'https://x/y.png'));
    expect(seenA).not.toHaveBeenCalled();
  });

  it('fan-outs to every subscriber on the same conversation', () => {
    const notifier = new InProcessArtifactNotifier();
    const sub1 = vi.fn();
    const sub2 = vi.fn();
    notifier.subscribe(conversationA, sub1);
    notifier.subscribe(conversationA, sub2);
    notifier.publish(event(conversationA, 'https://x/y.png'));
    expect(sub1).toHaveBeenCalledTimes(1);
    expect(sub2).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after dispose() is called', () => {
    const notifier = new InProcessArtifactNotifier();
    const seen = vi.fn();
    const sub = notifier.subscribe(conversationA, seen);
    notifier.publish(event(conversationA, 'https://1.png'));
    sub.dispose();
    notifier.publish(event(conversationA, 'https://2.png'));
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('publishing with no subscribers is a silent no-op', () => {
    const notifier = new InProcessArtifactNotifier();
    expect(() => notifier.publish(event(conversationA, 'https://x.png'))).not.toThrow();
  });
});
