import { RouterError } from '../core/errors';

interface CorrelationEntry {
  modelId: string;
  lastUsed: number;
}

export class CorrelationStore {
  private readonly entries = new Map<string, CorrelationEntry>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number,
  ) {}

  get(agentId: string): string | undefined {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;
    if (this.now() - entry.lastUsed > this.ttlMs) {
      this.entries.delete(agentId);
      return undefined;
    }
    entry.lastUsed = this.now();
    return entry.modelId;
  }

  bind(agentId: string, modelId: string): void {
    const existing = this.entries.get(agentId);
    if (existing && existing.modelId !== modelId) {
      throw new RouterError('correlation-conflict', `correlation-conflict: agent ${agentId} already bound to ${existing.modelId}`);
    }
    this.entries.set(agentId, { modelId, lastUsed: this.now() });
  }
}
