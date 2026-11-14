/**
 * Deterministic scorers for the Responder (Layer 4). Pure. They encode the
 * hard rules from the Responder's guardrails plus the product language rule
 * (neutral Latin-American Spanish with tuteo, never voseo). Judgement calls
 * (faithfulness, tone) live in `judge.ts`.
 */
import { SPECIAL_TOKENS } from '../../src/adapters/chat-output-adapter';
import type { Feedback } from './extractor';
import { countSentences, includesNormalized, normalizeText } from './text';

export interface ResponderExpectation {
  /** Each entry must appear in the reply (normalized), e.g. a pending value to confirm. */
  readonly mustMention?: ReadonlyArray<string>;
  /** None may appear, e.g. user values the current decision does not carry. */
  readonly mustNotMention?: ReadonlyArray<string>;
  /** Defaults to 2, the Responder's own limit. */
  readonly maxSentences?: number;
}

export interface ResponderScore {
  readonly pass: boolean;
  readonly feedback: ReadonlyArray<Feedback>;
}

/**
 * Common voseo forms. Deliberately a word list, not a suffix rule: a suffix
 * rule on "-ás/-és/-ís" would also hit "más", "después", "país".
 */
const VOSEO_RE = new RegExp(
  `(^|[^\\p{L}])(${[
    'vos', 'sos',
    'tenés', 'querés', 'podés', 'sabés', 'hacés', 'ponés', 'decís', 'venís', 'preferís', 'elegís',
    'buscás', 'necesitás', 'contás', 'pensás', 'imaginás', 'confirmás', 'describís',
    'contame', 'decime', 'mostrame', 'avisame', 'fijate', 'mirá', 'escribime', 'pasame',
  ].join('|')})(?=$|[^\\p{L}])`,
  'iu',
);

const GREETING_RE = /^\s*[¡!]?\s*(hola|buenas|buenos días|buenas tardes|buenas noches|qué tal|hey)(?=$|[^\p{L}])/iu;

/** Copied from the Responder guardrails (chat-output-adapter.ts buildGuardrails). */
const WAIT_FILLERS = [
  'estoy trabajando',
  'estamos trabajando',
  'dame un momentito',
  'dame un momento',
  'ya casi',
  'un segundo',
  'en breve',
  'enseguida',
];

/** Reasoning / prompt phrases a user-facing reply must never contain. */
const REASONING_PHRASES = ['analicemos', 'la regla dice', 'la instrucción', 'acción obligatoria', 'kind=', 'decisión actual', 'el usuario quiere', 'debo '];

export function findReasoningLeak(text: string): string | undefined {
  if (SPECIAL_TOKENS.test(text)) return 'special token';
  const lower = text.toLowerCase();
  return REASONING_PHRASES.find((p) => lower.includes(p));
}

export function findVoseo(text: string): string | undefined {
  return VOSEO_RE.exec(text)?.[2];
}

export function scoreReply(reply: string, expected: ResponderExpectation = {}): ResponderScore {
  const voseo = findVoseo(reply);
  const greeting = GREETING_RE.test(reply);
  const fillers = WAIT_FILLERS.filter((f) => normalizeText(reply).includes(normalizeText(f)));
  const sentences = countSentences(reply);
  const maxSentences = expected.maxSentences ?? 2;
  const code = /```|^\s*[[{]/.test(reply);
  const leak = findReasoningLeak(reply);
  const missing = (expected.mustMention ?? []).filter((m) => !includesNormalized(reply, m));
  const leaked = (expected.mustNotMention ?? []).filter((m) => includesNormalized(reply, m));

  const feedback: Feedback[] = [
    { key: 'responder.non_empty', score: reply.trim().length > 0 ? 1 : 0 },
    { key: 'responder.no_voseo', score: voseo ? 0 : 1, comment: voseo ? `found "${voseo}"` : undefined },
    { key: 'responder.no_greeting', score: greeting ? 0 : 1 },
    { key: 'responder.no_wait_fillers', score: fillers.length === 0 ? 1 : 0, comment: fillers.join(', ') || undefined },
    { key: 'responder.max_sentences', score: sentences <= maxSentences ? 1 : 0, comment: `${sentences} sentence(s)` },
    { key: 'responder.no_code', score: code ? 0 : 1 },
    { key: 'responder.no_reasoning_leak', score: leak ? 0 : 1, comment: leak ? `found "${leak}"` : undefined },
    { key: 'responder.mentions_required', score: missing.length === 0 ? 1 : 0, comment: missing.length ? `missing: ${missing.join(', ')}` : undefined },
    { key: 'responder.no_leaked_values', score: leaked.length === 0 ? 1 : 0, comment: leaked.length ? `leaked: ${leaked.join(', ')}` : undefined },
  ];
  return { pass: feedback.every((f) => f.score === 1), feedback };
}
