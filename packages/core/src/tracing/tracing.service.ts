// packages/core/src/tracing/tracing.service.ts
//
// Turns tracing across apps on for this process while the module runs: incoming `traceparent`,
// outgoing calls to the targets, and the slot the BullMQ watcher reads.
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import { CONTEXT_ACCESSOR, type ContextAccessor } from '../context/context-accessor.js';
import { forEachAxiosInstance } from '../http/axios-instances.js';
import {
  TELESCOPE_CONFIG,
  TELESCOPE_OPTIONS,
  type TelescopeModuleOptions,
} from '../nest/telescope.options.js';
import { TelescopeService } from '../nest/telescope.service.js';
import { createWatcherContext } from '../nest/watcher-context.factory.js';
import { resolveTopology } from '../topology/config.js';
import { attachTracingToAxios } from './axios.js';
import {
  type PropagationOptions,
  type ResolvedPropagation,
  propagatesOutbound,
  resolvePropagation,
} from './config.js';
import { installOutboundPropagation } from './outbound.js';
import { publishTracingSlot, setTracingRuntime } from './runtime.js';

/** Whether `propagation` turns anything on (an app that configures nothing installs nothing). */
function isActive(config: ResolvedPropagation): boolean {
  return config.incoming || config.startTraces || propagatesOutbound(config);
}

@Injectable()
export class TelescopeTracing implements OnModuleInit, OnModuleDestroy {
  readonly config: ResolvedPropagation;
  private stops: Array<() => void> = [];
  private readonly axios: PropagationOptions['axios'];

  constructor(
    @Inject(TELESCOPE_OPTIONS) options: TelescopeModuleOptions,
    @Inject(TELESCOPE_CONFIG) private readonly core: ResolvedCoreConfig,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(TelescopeService) private readonly service: TelescopeService,
    @Optional()
    @Inject(CONTEXT_ACCESSOR)
    private readonly accessor: ContextAccessor | undefined = undefined,
  ) {
    this.axios = options.propagation?.axios;
    // A tenant or a control plane continues incoming traces by default: its traces cross apps.
    const kind = resolveTopology(options).kind;
    this.config = resolvePropagation(options.propagation, kind !== 'standalone');
  }

  /** Whether this app keeps traces across apps (the Traces page has something to show). */
  get active(): boolean {
    return this.core.enabled && isActive(this.config);
  }

  onModuleInit(): void {
    if (!this.active) return;
    const accessor = this.accessor;
    this.stops = [
      setTracingRuntime({
        incoming: this.config.incoming,
        startTraces: this.config.startTraces,
        queue: this.config.queue,
        contextTraceId: () => {
          const id = accessor?.traceId();
          return typeof id === 'string' && id !== '' ? id : undefined;
        },
      }),
      installOutboundPropagation(this.config),
      publishTracingSlot(),
    ];
    // `@nestjs/axios`'s HttpService (every one in the app) and the instances the app handed over.
    if (propagatesOutbound(this.config)) {
      forEachAxiosInstance(
        this.axios,
        this.moduleRef,
        () => createWatcherContext(this.service, this.core, this.moduleRef),
        (instance) => this.stops.push(attachTracingToAxios(instance, this.config)),
      );
    }
  }

  onModuleDestroy(): void {
    for (const stop of this.stops.splice(0)) stop();
  }
}
