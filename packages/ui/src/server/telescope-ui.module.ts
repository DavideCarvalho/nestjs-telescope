import { type DynamicModule, Module } from '@nestjs/common';
import { TelescopeUiController } from './telescope-ui.controller.js';
import { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';

@Module({})
export class TelescopeUiModule {
  static forRoot(options: TelescopeUiModuleOptions = {}): DynamicModule {
    return {
      module: TelescopeUiModule,
      controllers: [TelescopeUiController],
      providers: [{ provide: TELESCOPE_UI_OPTIONS, useValue: options }],
    };
  }
}
