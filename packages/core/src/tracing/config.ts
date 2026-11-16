// packages/core/src/tracing/config.ts
//
// `propagation` in `TelescopeModule.forRoot()`: carry one trace across your apps.

/** `propagation` in `TelescopeModule.forRoot()`. */
export interface PropagationOptions {
  /**
   * Where outgoing calls carry the trace (`traceparent`, plus the caller's `tracestate`): origins
   * (`https://billing.internal`; a URL with a path is read for its origin), `RegExp`s tested
   * against the origin, or `'all'` (third parties included). Default `[]`: nothing is sent.
   */
  targets?: ReadonlyArray<string | RegExp> | 'all';
  /**
   * Continue the `traceparent` an incoming request carries. Default `true`. Set `false` on an app
   * the public calls directly when callers must not choose its trace ids.
   */
  incoming?: boolean;
  /**
   * Also add the headers to `node:http` / `node:https` calls (`http.request`, axios, got). `fetch`
   * is always covered. Default `false`.
   */
  nodeHttp?: boolean;
  /**
   * Carry the trace in BullMQ jobs (with `@dudousxd/nestjs-telescope-bullmq`): a job dispatched
   * inside a request runs in that request's trace, whichever app's worker runs it. Default `true`.
   */
  queue?: boolean;
}

/** {@link PropagationOptions} with defaults. */
export interface ResolvedPropagation {
  /** `'all'`, or the matchers (empty: nothing is sent). */
  targets: 'all' | Array<string | RegExp>;
  incoming: boolean;
  nodeHttp: boolean;
  queue: boolean;
  /**
   * Whether a request no caller sent a trace for starts one. Only when the app set `propagation`:
   * an app that configures nothing records exactly as before.
   */
  startTraces: boolean;
}

/** The origin (`scheme://host[:port]`) of `value`, lowercased; `null` when it is not an http(s) URL. */
export function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolve `propagation`. `continueByDefault`: whether an incoming `traceparent` is continued when
 * `propagation` is omitted (a tenant or a control plane: its traces cross apps). A standalone app
 * that configures nothing is unchanged. Throws on a target that is not an http(s) origin.
 */
export function resolvePropagation(
  config: PropagationOptions | undefined,
  continueByDefault: boolean,
): ResolvedPropagation {
  if (config === undefined) {
    return {
      targets: [],
      incoming: continueByDefault,
      nodeHttp: false,
      queue: continueByDefault,
      startTraces: false,
    };
  }
  const raw = config.targets ?? [];
  let targets: ResolvedPropagation['targets'];
  if (raw === 'all') {
    targets = 'all';
  } else if (Array.isArray(raw)) {
    targets = raw.map((target) => {
      if (target instanceof RegExp) return target;
      const origin = typeof target === 'string' ? originOf(target) : null;
      if (origin === null) {
        throw new Error(
          `telescope: propagation.targets: ${JSON.stringify(target)} is not an http(s) origin (e.g. "https://billing.internal").`,
        );
      }
      return origin;
    });
  } else {
    throw new Error("telescope: propagation.targets must be a list of origins or 'all'.");
  }
  return {
    targets,
    incoming: config.incoming ?? true,
    nodeHttp: config.nodeHttp ?? false,
    queue: config.queue ?? true,
    startTraces: true,
  };
}

/** Whether a call to `origin` may carry the trace. */
export function isPropagationTarget(
  targets: ResolvedPropagation['targets'],
  origin: string | null,
): boolean {
  if (origin === null) return false;
  if (targets === 'all') return true;
  for (const target of targets) {
    if (typeof target === 'string') {
      if (target === origin) return true;
    } else {
      target.lastIndex = 0;
      if (target.test(origin)) return true;
    }
  }
  return false;
}

/** Whether outgoing calls carry the trace at all. */
export function propagatesOutbound(config: ResolvedPropagation): boolean {
  return config.targets === 'all' || config.targets.length > 0;
}
