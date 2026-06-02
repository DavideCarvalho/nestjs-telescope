// packages/core/src/nest/telescope.guard.ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

@Injectable()
export class TelescopeGuard implements CanActivate {
  constructor(@Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<unknown>();
    if (this.options.authorizer) {
      return this.options.authorizer({ request });
    }
    // Safe default: open in dev, closed in production.
    return process.env.NODE_ENV !== 'production';
  }
}
