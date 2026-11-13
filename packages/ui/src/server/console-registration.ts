import {
  TELESCOPE_CONSOLE_ID,
  normalizeTelescopePath,
  registerAviaryConsole,
  resolveConsoleAuthorize,
  telescopeConsoleSearch,
} from '@dudousxd/nestjs-telescope';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

const logger = new Logger('TelescopeUiModule');

/**
 * Registers the telescope console into the Aviary console switcher (its page path, gated by the
 * page's resolved `authorize`). Provided only when the page is mounted; removed on shutdown.
 */
@Injectable()
export class TelescopeConsoleRegistration implements OnModuleInit, OnModuleDestroy {
  #unregister: (() => void) | undefined;

  constructor(
    @Inject(TELESCOPE_UI_OPTIONS) private readonly options: TelescopeUiModuleOptions,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    const decide = await resolveConsoleAuthorize(this.options.authorize, this.moduleRef, {
      warnIfMissing: false,
    });
    const path = `/${normalizeTelescopePath(this.options.path)}`;
    this.#unregister = registerAviaryConsole(
      {
        id: TELESCOPE_CONSOLE_ID,
        title: 'Telescope',
        icon: 'telescope',
        order: 20,
        path,
        authorize: decide,
        search: telescopeConsoleSearch(this.moduleRef, decide, path),
      },
      logger,
    );
  }

  onModuleDestroy(): void {
    this.#unregister?.();
    this.#unregister = undefined;
  }
}
