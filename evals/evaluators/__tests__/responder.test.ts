/**
 * Unit tests for the Responder scorers and text helpers. Pure, no LLM.
 */
import { describe, expect, it } from 'vitest';
import { findVoseo, scoreReply } from '../responder';
import { countSentences, normalizeText } from '../text';

const keyScore = (reply: string, e?: Parameters<typeof scoreReply>[1]) =>
  Object.fromEntries(scoreReply(reply, e).feedback.map((f) => [f.key, f.score]));

describe('normalizeText', () => {
  it('folds case, accents, ñ, quotes and spacing', () => {
    expect(normalizeText('  «Café   Ñusta»  ')).toBe('cafe nusta');
  });
});

describe('countSentences', () => {
  it('counts a ¿…? question as one sentence and ignores trailing emoji', () => {
    expect(countSentences('Ya estoy generando tu logo. ¿Qué tono buscas para el eslogan? ✨')).toBe(2);
  });
  it('counts three sentences', () => {
    expect(countSentences('Uno. Dos! ¿Tres?')).toBe(3);
  });
  it('treats a reply with no terminator as one sentence', () => {
    expect(countSentences('Listo, tu logo está en el panel lateral')).toBe(1);
  });
});

describe('findVoseo', () => {
  it('detects common voseo forms', () => {
    expect(findVoseo('¿Qué estilo querés para el logo?')).toBe('querés');
    expect(findVoseo('Contame qué hace tu negocio.')).toBe('Contame');
  });
  it('does not flag tuteo or words that only end like voseo', () => {
    expect(findVoseo('¿Qué estilo quieres? Después vemos más colores del país.')).toBeUndefined();
  });
});

describe('scoreReply', () => {
  it('passes a clean two-sentence tuteo reply', () => {
    expect(scoreReply('Ya estoy generando tu logo. ¿Qué tono prefieres para el eslogan?').pass).toBe(true);
  });

  it('flags greetings, wait fillers and code', () => {
    const s = keyScore('¡Hola! Dame un momento. {"a":1}');
    expect(s['responder.no_greeting']).toBe(0);
    expect(s['responder.no_wait_fillers']).toBe(0);
    expect(keyScore('```json\n{}\n```')['responder.no_code']).toBe(0);
  });

  it('enforces mustMention and mustNotMention with normalized matching', () => {
    const reply = 'Entiendo que tu negocio se llama Dulce Hogar, ¿es correcto?';
    expect(keyScore(reply, { mustMention: ['dulce hogar'] })['responder.mentions_required']).toBe(1);
    expect(keyScore(reply, { mustNotMention: ['DULCE HOGAR'] })['responder.no_leaked_values']).toBe(0);
  });
});
