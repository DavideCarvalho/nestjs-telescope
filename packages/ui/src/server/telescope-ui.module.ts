import { dynamicController, normalizeTelescopePath } from '@dudousxd/nestjs-telescope';
import { type DynamicModule, Module } from '@nestjs/common';
import { TelescopeUiController } from './telescope-ui.controller.js';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

@Module({})
export class TelescopeUiModule {
  static forRoot(options: TelescopeUiModuleOptions = {}): DynamicModule {
    const path = normalizeTelescopePath(options.path);
    return {
      module: TelescopeUiModule,
      controllers: [dynamicController(TelescopeUiController, path)],
      providers: [{ provide: TELESCOPE_UI_OPTIONS, useValue: options }],
    };
  }
}
