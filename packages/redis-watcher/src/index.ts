// packages/redis-watcher/src/index.ts
export { RedisCommandWatcher } from './redis-command.watcher.js';
export { REDIS_REDACTED, redactRedisArgs } from './redis-redaction.js';
export type {
  CustomRedisSource,
  RedisCommandWatcherOptions,
  RedisClientLike,
  RedisCommandLike,
} from './redis-command.watcher.js';
