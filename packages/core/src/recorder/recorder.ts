// packages/core/src/recorder/recorder.ts
import type { Entry, RecordInput } from '../entry/entry.js';
import type { TelescopeContext } from '../context/telescope-context.js';
import type { RedactOptions } from '../redaction/redact.js';
import { redact } from '../redaction/redact.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import type { Tagger } from '../tagging/tagger.js';
import { runTaggers } from '../tagging/tagger.js';

export interface RecorderOptions {
  storage: StorageProvider;
  context: TelescopeContext;
  instanceId: string;
  taggers: Tagger[];
  redact: RedactOptions;
  /** Per-type keep-rate 0..1. Missing type ⇒ keep (rate 1). */
  sampling: Record<string, number>;
  bufferSize: number;
  now?: () => number;
  random?: () => number;
  idFactory: () => string;
}

export class Recorder {
  private readonly buffer: Entry[] = [];
  private readonly now: () => number;
  private readonly random: () => number;
  private dropped = 0;

  constructor(private readonly options: RecorderOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** Synchronous, O(1), never throws into the caller. */
  record(input: RecordInput): void {
    try {
      if (!this.passesSampling(input.type)) {
        return;
      }
      this.push(this.enrich(input));
    } catch {
      // A telescope bug must never break the host. Swallow.
      this.dropped += 1;
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }
    const drained = this.buffer.splice(0, this.buffer.length);
    try {
      await this.options.storage.store(drained);
    } catch {
      // Drop on storage failure rather than block or grow.
      this.dropped += drained.length;
    }
  }

  private passesSampling(type: string): boolean {
    const rate = this.options.sampling[type];
    if (rate === undefined || rate >= 1) {
      return true;
    }
    if (rate <= 0) {
      return false;
    }
    return this.random() < rate;
  }

  private enrich(input: RecordInput): Entry {
    const batch = this.options.context.current();
    // Resolve batchId FIRST: an out-of-batch entry's synthetic batch id uses
    // id-0, and the entry id uses id-1, keeping allocation order predictable.
    const batchId = batch?.id ?? this.options.idFactory();
    const base: Entry = {
      id: this.options.idFactory(),
      batchId,
      type: input.type,
      familyHash: input.familyHash ?? null,
      content: redact(input.content, this.options.redact),
      tags: input.tags ?? [],
      sequence: this.options.context.nextSequence(),
      durationMs: input.durationMs ?? null,
      origin: batch?.origin ?? 'manual',
      instanceId: this.options.instanceId,
      createdAt: new Date(this.now()),
    };
    return { ...base, tags: runTaggers(base, this.options.taggers) };
  }

  private push(entry: Entry): void {
    if (this.buffer.length >= this.options.bufferSize) {
      this.buffer.shift();
      this.dropped += 1;
    }
    this.buffer.push(entry);
  }
}
