// packages/core/src/nest/telescope-action.guard.ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { type QueueActionRequest, isQueueAction, isQueueState } from '../queue/queue-manager.js';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

interface MutationParams {
  driver?: string;
  queue?: string;
  action?: string;
  id?: string;
}
interface MutationQuery {
  state?: string;
}

/**
 * Resolve the requested action. Most mutation routes carry it as the `:action`
 * path param. Enqueue uses a fixed `/enqueue` segment (it carries a JSON body),
 * so it has no `:action` param — we recover it from the request URL path.
 */
function resolveAction(params: MutationParams, url: string | undefined): string | undefined {
  if (params.action !== undefined) return params.action;
  const path = (url ?? '').split('?')[0] ?? '';
  if (path.endsWith('/enqueue')) return 'enqueue';
  return undefined;
}

@Injectable()
export class TelescopeActionGuard implements CanActivate {
  constructor(@Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Default-deny: no authorizeAction means mutations are forbidden.
    if (!this.options.authorizeAction) return false;
    const request = context
      .switchToHttp()
      .getRequest<{ params?: MutationParams; query?: MutationQuery; url?: string }>();
    const params = request.params ?? {};
    const query = request.query ?? {};
    const resolvedAction = resolveAction(params, request.url);
    if (!params.driver || !params.queue || !isQueueAction(resolvedAction)) return false;
    const action: QueueActionRequest = {
      driver: params.driver,
      queue: params.queue,
      action: resolvedAction,
      ...(params.id !== undefined ? { jobId: params.id } : {}),
      ...(isQueueState(query.state) ? { state: query.state } : {}),
    };
    try {
      return await this.options.authorizeAction({ request }, action);
    } catch {
      return false; // fail closed
    }
  }
}
