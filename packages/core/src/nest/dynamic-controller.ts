// packages/core/src/nest/dynamic-controller.ts
import 'reflect-metadata';
import { Controller, type Type } from '@nestjs/common';

/**
 * `@nestjs/authorization`'s `CAN_ANYONE_METADATA` key (what `@Can.Anyone()`
 * writes), INLINED: the package does not export it, and Telescope takes no
 * dependency on `@nestjs/authorization`. A drift spec asserts the literal still
 * opens a route under the real `AuthorizationGuard`.
 */
export const AUTHORIZATION_CAN_ANYONE_METADATA = 'authorization:can-anyone';

/**
 * Builds a per-`forRoot` subclass of an implementation controller and applies
 * `@Controller(path)` to it at module-build time, so the mount path is
 * configurable without touching the static `@Controller(...)` on the base class.
 *
 * Method-level metadata (`@Get`/`@Post`/`@UseGuards`/...) lives on the base
 * class prototype and is inherited by the subclass, and the subclass inherits
 * the same constructor — so DI injects the identical dependencies. Only the
 * class-level route path is overridden here.
 *
 * Every subclass is also marked open to `@nestjs/authorization`'s deny-by-default
 * global `AuthorizationGuard` (the `@Can.Anyone()` mark), so an undecorated dev
 * console still answers once an app adopts that package. That mark only opens
 * routes that declare no requirement, so a `Can(...)` passed in `decorators` is
 * still enforced.
 *
 * `decorators` (the host's `decorators` option) are applied, in order, to the
 * fresh subclass only — never to `base` — so one registration's decorators
 * cannot leak into another's.
 */
export function dynamicController(
  base: Type<object>,
  path: string,
  decorators: readonly ClassDecorator[] = [],
): Type<object> {
  // A named, otherwise-empty subclass: inherits prototype methods (route metadata)
  // and the base constructor (DI signature) verbatim.
  class DynamicController extends base {}
  Object.defineProperty(DynamicController, 'name', { value: `Dynamic${base.name}` });
  Controller(path)(DynamicController);
  return applyControllerDecorators(DynamicController, decorators);
}

/**
 * Marks `controller` open to `@nestjs/authorization` (see
 * {@link AUTHORIZATION_CAN_ANYONE_METADATA}), then applies the host's
 * `decorators` to it in order. Call it on a class built for ONE registration
 * (a fresh subclass), never on a shared one, or decorators leak across
 * registrations. Returns the decorated class (a decorator may return a
 * replacement class, as a TypeScript class decorator can).
 */
export function applyControllerDecorators(
  controller: Type<object>,
  decorators: readonly ClassDecorator[] = [],
): Type<object> {
  Reflect.defineMetadata(AUTHORIZATION_CAN_ANYONE_METADATA, true, controller);
  let decorated = controller;
  for (const decorator of decorators) {
    const replacement = decorator(decorated);
    if (typeof replacement === 'function') decorated = replacement as unknown as Type<object>;
  }
  return decorated;
}

/** The `decorators` value the production-rule error shows as its example. */
export const CONSOLE_DECORATORS_EXAMPLE =
  "decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')]";

/** What {@link assertConsoleProtected} names in its error, per module. */
export interface ConsoleProtectionHint {
  /** The module being registered, e.g. `TelescopeModule`. */
  module: string;
  /** One-line registration with `decorators`. */
  decoratorsExample: string;
  /** One-line `routes: false` registration plus the controller the host writes. */
  selfMountExample: string;
}

/**
 * The production rule: with `NODE_ENV === 'production'`, a module that mounts
 * its routes (no `routes: false`) with no `decorators` (an empty array counts
 * as none) refuses to boot. Outside production it is a no-op, so an
 * undecorated console mounts open (marked can-anyone) for local work.
 *
 * It only checks that decorators are present: it cannot tell whether they
 * enforce anything (a no-op decorator, or a `Can(...)` with no
 * `AuthorizationModule` installed, passes and leaves the routes open).
 *
 * Throws at module-build time (`forRoot` / `forRootAsync`), so the app fails
 * before it listens rather than shipping an open console.
 */
export function assertConsoleProtected(
  decorators: readonly ClassDecorator[] | undefined,
  hint: ConsoleProtectionHint,
): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (decorators !== undefined && decorators.length > 0) return;
  throw new Error(
    [
      `${hint.module}: refusing to mount undecorated routes with NODE_ENV=production. Protect them with the official NestJS tools (@nestjs/authentication, @nestjs/authorization), one of two ways:`,
      `  1. decorators on the mounted controllers: ${hint.decoratorsExample}`,
      `  2. mount the routes yourself: ${hint.selfMountExample}`,
      'The check only sees that decorators are present, not that they enforce anything: pass ones that reject (a Can(...) needs AuthorizationModule installed).',
    ].join('\n'),
  );
}
