export type ProducerKind = 'claude' | 'codex' | 'unknown';
export type ReviewerKind = 'claude' | 'codex' | 'default';

export interface RoutingDecision {
  producer: ProducerKind;
  reviewer: ReviewerKind;
  reason: 'heterogeneous' | 'fallback' | 'no-source';
}

export function detectProducer(
  source?: string,
  pushedBy?: string
): ProducerKind {
  const combined = `${source ?? ''} ${pushedBy ?? ''}`.toLowerCase();
  if (combined.includes('claude')) return 'claude';
  if (combined.includes('codex')) return 'codex';
  return 'unknown';
}

export function pickReviewer(
  producer: ProducerKind,
  defaultReviewer: Exclude<ReviewerKind, 'default'> = 'claude'
): RoutingDecision {
  if (producer === 'claude') {
    return { producer, reviewer: 'codex', reason: 'heterogeneous' };
  }
  if (producer === 'codex') {
    return { producer, reviewer: 'claude', reason: 'heterogeneous' };
  }
  if (producer === 'unknown') {
    return { producer, reviewer: defaultReviewer, reason: 'fallback' };
  }
  return { producer, reviewer: defaultReviewer, reason: 'no-source' };
}