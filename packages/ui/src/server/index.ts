export { TelescopeUiModule } from './telescope-ui.module.js';
export {
  TELESCOPE_DASHBOARD_CONFIG_ID,
  TelescopeUiController,
} from './telescope-ui.controller.js';
export { TelescopeConsoleRegistration } from './console-registration.js';
export { TELESCOPE_UI_OPTIONS, type TelescopeUiModuleOptions } from './telescope-ui.options.js';
// The console access contract, re-exported from core so the UI's `authorize`
// can be written from this entry point.
export {
  ConsoleAccessDenied,
  ConsoleAuthorizeFilter,
  ConsoleAuthorizeGuard,
  ConsolePage,
  UseConsoleAuthorize,
  anyAuthorize,
  authorizeByToken,
  normalizeConsoleResult,
  resolveConsoleAuthorize,
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  type ConsoleAuthorizerClass,
  type ConsoleDecide,
  type ConsoleDecision,
  type ConsolePolicyCheck,
  type UseConsoleAuthorizeOptions,
} from '@dudousxd/nestjs-telescope';
