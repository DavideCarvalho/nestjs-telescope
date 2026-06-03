// packages/core/src/nest/dynamic-controller.ts
import { Controller, type Type } from '@nestjs/common';

/**
 * Builds a per-`forRoot` subclass of an implementation controller and applies
 * `@Controller(path)` to it at module-build time, so the mount path is
 * configurable without touching the static `@Controller(...)` on the base class.
 *
 * Method-level metadata (`@Get`/`@Post`/`@UseGuards`/...) lives on the base
 * class prototype and is inherited by the subclass, and the subclass inherits
 * the same constructor — so DI injects the identical dependencies. Only the
 * class-level route path is overridden here.
 */
export function dynamicController(base: Type<object>, path: string): Type<object> {
  // A named, otherwise-empty subclass: inherits prototype methods (route metadata)
  // and the base constructor (DI signature) verbatim.
  class DynamicController extends base {}
  Object.defineProperty(DynamicController, 'name', { value: `Dynamic${base.name}` });
  Controller(path)(DynamicController);
  return DynamicController;
}
