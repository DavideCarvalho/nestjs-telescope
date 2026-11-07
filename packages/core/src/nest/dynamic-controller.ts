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
 * global `AuthorizationGuard` (the `@Can.Anyone()` mark): Telescope's own gates
 * keep deciding who reaches it. That mark only opens routes that declare no
 * requirement, so a `Can(...)` passed in `decorators` is still enforced.
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
