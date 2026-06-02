// packages/core/src/nest/telescope.guard.ts
import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { TELESCOPE_OPTIONS, type TelescopeModuleOptions } from './telescope.options.js';

@Injectable()
export class TelescopeGuard implements CanActivate {
  constructor(@Inject(TELESCOPE_OPTIONS) private readonly options: TelescopeModuleOptions) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<unknown>();
    if (this.options.authorizer) {
      try {
        return await this.options.authorizer({ request });
      } catch {
        // Fail closed: a throwing authorizer denies access (clean 403),
        // never accidentally grants it or surfaces a 500.
        return false;
      }
    }
    // Safe default: open in dev, closed in production. An unset NODE_ENV is
    // treated as non-production (local/dev context).
    return process.env.NODE_ENV !== 'production';
  }
}
