/**
 * Unit tests for the notifiers over the notification contract (KAN-58).
 * InProcessArtifactNotifier: subscribe/publish fan-out, conversation scoping,
 * dispose semantics, silent no-op without subscribers. Redis notifiers (over
 * a loopback fake): payloads parse through the contract, malformed or
 * mis-scoped messages are dropped (not crashed on), a throwing handler is
 * isolated.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Redis as RedisClient } from 'ioredis';

import { InProcessArtifactNotifier, type ArtifactPublishedEvent } from '../artifact-notifier';
import { RedisArtifactNotifier } from '../redis-artifact-notifier';
import { RedisAgentLifecycleNotifier } from '../redis-agent-lifecycle-notifier';
import { RedisDecisionNotifier } from '../redis-decision-notifier';
import { InProcessDecisionNotifier } from '../orchestrator-core';
import { FakeSubscriber, flushMicrotasks } from '../../../workers/__tests__/_helpers';

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

/** Publisher that loops every message back into the fake subscriber, like Redis would. */
class LoopbackPublisher {
  readonly published: Array<{ channel: string; message: string }> = [];
  constructor(private readonly subscriber: FakeSubscriber) {}
  async publish(channel: string, message: string): Promise<number> {
    this.published.push({ channel, message });
    if (this.subscriber.subscribed.includes(channel)) this.subscriber.emitMessage(channel, message);
    return 1;
  }
}

function redisPair() {
  const subscriber = new FakeSubscriber();
  const publisher = new LoopbackPublisher(subscriber);
  return {
    subscriber,
    publisher,
    asRedis: [publisher as unknown as RedisClient, subscriber as unknown as RedisClient] as const,
  };
}

describe('Redis notifiers over the notification contract', () => {
  it('publishes a versioned envelope and delivers the parsed payload', async () => {
    const { publisher, asRedis } = redisPair();
    const notifier = new RedisArtifactNotifier(...asRedis);
    const seen = vi.fn();
    notifier.subscribe(conversationA, seen);
    notifier.publish(event(conversationA, 'https://x/y.png'));
    await flushMicrotasks();
    expect(publisher.published[0]).toMatchObject({ channel: `mypes:artifact:${conversationA}` });
    expect(JSON.parse(publisher.published[0].message)).toMatchObject({ v: 1, kind: 'artifact_published' });
    expect(seen).toHaveBeenCalledWith(event(conversationA, 'https://x/y.png'));
  });

  it.each([
    ['not JSON', 'oops'],
    ['a pre-contract payload', JSON.stringify(event(conversationA, 'https://x/y.png'))],
    ['another kind', JSON.stringify({ v: 1, kind: 'task_dispatch', taskId: 't', tenantId: 'x', agentId: 'logo-agent' })],
    ['a payload for another conversation', JSON.stringify({ v: 1, kind: 'artifact_published', ...event(conversationB, 'https://x.png') })],
    ['an invalid artifact list', JSON.stringify({ v: 1, kind: 'artifact_published', ...event(conversationA, 'u'), artifacts: 'nope' })],
  ])('drops %s without calling handlers or throwing', async (_label, raw) => {
    const { subscriber, asRedis } = redisPair();
    const notifier = new RedisArtifactNotifier(...asRedis);
    const seen = vi.fn();
    notifier.subscribe(conversationA, seen);
    expect(() => subscriber.emitMessage(`mypes:artifact:${conversationA}`, raw)).not.toThrow();
    expect(seen).not.toHaveBeenCalled();
  });

  it('isolates a throwing handler from the other subscribers', async () => {
    const { asRedis } = redisPair();
    const notifier = new RedisAgentLifecycleNotifier(...asRedis);
    const ok = vi.fn();
    notifier.subscribeProcessing(conversationA, () => {
      throw new Error('boom');
    });
    notifier.subscribeProcessing(conversationA, ok);
    notifier.publishProcessing({ conversationId: conversationA, agentId: 'logo-agent', taskId: 't-1', claimedAt: 'now' });
    await flushMicrotasks();
    expect(ok).toHaveBeenCalledWith({ conversationId: conversationA, agentId: 'logo-agent', taskId: 't-1', claimedAt: 'now' });
  });

  it('round-trips a planner decision; unsubscribes when the last handler disposes', async () => {
    const { subscriber, asRedis } = redisPair();
    const notifier = new RedisDecisionNotifier(...asRedis);
    const seen = vi.fn();
    const sub = notifier.subscribe(conversationA, seen);
    notifier.notify(conversationA, { kind: 'announce_all_complete' });
    await flushMicrotasks();
    expect(seen).toHaveBeenCalledWith({ kind: 'announce_all_complete' });
    sub.dispose();
    expect(subscriber.unsubscribed).toContain(`mypes:decision:${conversationA}`);
  });

  it('the in-process decision notifier applies the same contract', () => {
    const notifier = new InProcessDecisionNotifier();
    const seen = vi.fn();
    notifier.subscribe(conversationA, seen);
    notifier.notify(conversationA, { kind: 'offer_generation', agentId: 'logo-agent', deliverableKind: 'logo' });
    expect(seen).toHaveBeenCalledWith({ kind: 'offer_generation', agentId: 'logo-agent', deliverableKind: 'logo' });
  });
});
