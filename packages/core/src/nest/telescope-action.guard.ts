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

@Injectable()
export class TelescopeActionGuard implements CanActivate {
  constructor(@Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Default-deny: no authorizeAction means mutations are forbidden.
    if (!this.options.authorizeAction) return false;
    const request = context
      .switchToHttp()
      .getRequest<{ params?: MutationParams; query?: MutationQuery }>();
    const params = request.params ?? {};
    const query = request.query ?? {};
    if (!params.driver || !params.queue || !isQueueAction(params.action)) return false;
    const action: QueueActionRequest = {
      driver: params.driver,
      queue: params.queue,
      action: params.action,
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
