export { TelescopeUiModule } from './telescope-ui.module.js';
export { TelescopeUiController } from './telescope-ui.controller.js';
export { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';
// The console access contract, re-exported from core so the UI's `authorize`
// can be written from this entry point.
export {
  ConsoleAuthorizeGuard,
  ConsoleDeniedFilter,
  UseConsoleAuthorize,
  authorizeByToken,
  resolveConsoleAuthorize,
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  type ConsoleAuthorizerClass,
  type ConsoleDecision,
  type ConsolePolicyCheck,
} from '@dudousxd/nestjs-telescope';
