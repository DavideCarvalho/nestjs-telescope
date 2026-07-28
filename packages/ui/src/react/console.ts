// The console launcher on its own subpath (`@dudousxd/nestjs-telescope-ui/react/console`).
//
// It is also exported from `./react`, but that barrel re-exports the whole dashboard component set,
// which pulls in `recharts` and `react-router-dom`. Those are not declared by this package, so a
// host that wants ONLY the launcher — the common case, a button on an admin page — cannot import
// from the barrel: a bundler resolves re-exported modules even when nothing uses them, and the
// build fails on the missing dependency rather than tree-shaking it away.
//
// This entry re-exports only the launcher and the headless primitives it wraps, so its entire
// dependency footprint is `react`.
export * from './use-open-console.js';
export * from './open-console-button.js';
export {
  ConsoleSessionError,
  telescopeConsoleSessionUrl,
  telescopeConsoleUrl,
  mintTelescopeConsoleSession,
  openTelescopeConsole,
  type OpenConsoleOptions,
} from '../client/console-session.js';
