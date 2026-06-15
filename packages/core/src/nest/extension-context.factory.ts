import type { ModuleRef } from '@nestjs/core';
import type { ResolvedCoreConfig } from '../config/options.js';
import type { ExtensionContext } from '../extension/types.js';

/** Build the read-only context handed to extension hooks/providers. */
export function createExtensionContext(
  moduleRef: ModuleRef,
  config: ResolvedCoreConfig,
): ExtensionContext {
  return { moduleRef, config };
}
