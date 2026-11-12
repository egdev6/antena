import type { Metric } from './types';

/** Goal-only metrics need a label without adding a synthetic session total. */
export function goalMetricLabel(key: string, metrics: Record<string, Metric>): string {
  return metrics[key]?.label || (key === 'subscribers' ? 'Suscriptores' : key);
}
