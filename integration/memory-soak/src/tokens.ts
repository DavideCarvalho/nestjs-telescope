// integration/memory-soak/src/tokens.ts
import type { SoakConfig } from './config.js';

/** The subset of the soak config the controller needs at request time. */
export type SoakConfigToken = Pick<
  SoakConfig,
  'fatUser' | 'cacheEmitsPerRequest' | 'queryRecordsPerRequest' | 'exceptions'
>;

export const SOAK_CONFIG = Symbol('SOAK_CONFIG');
