// packages/redis-watcher/src/redis-redaction.spec.ts
import { describe, expect, it } from 'vitest';
import { REDIS_REDACTED as R, redactRedisArgs } from './redis-redaction.js';

describe('redactRedisArgs', () => {
  it.each([
    ['SET', ['k', 'v', 'EX', 60, 'NX'], ['k', R, 'EX', 60, 'NX']],
    ['set', ['k', 'v'], ['k', R]],
    ['SETEX', ['k', 60, 'v'], ['k', 60, R]],
    ['PSETEX', ['k', 60000, 'v'], ['k', 60000, R]],
    ['GETSET', ['k', 'v'], ['k', R]],
    ['MSET', ['a', '1', 'b', '2'], ['a', R, 'b', R]],
    ['HSET', ['h', 'f1', 'v1', 'f2', 'v2'], ['h', 'f1', R, 'f2', R]],
    ['HMSET', ['h', 'f1', 'v1'], ['h', 'f1', R]],
    ['LPUSH', ['l', 'a', 'b'], ['l', R, R]],
    ['RPUSH', ['l', 'a'], ['l', R]],
    ['SADD', ['s', 'token'], ['s', R]],
    ['ZADD', ['z', 'NX', 1, 'm1', 2, 'm2'], ['z', 'NX', 1, R, 2, R]],
    ['XADD', ['st', 'MAXLEN', '~', 1000, '*', 'f', 'v'], ['st', 'MAXLEN', '~', 1000, '*', 'f', R]],
    ['XADD', ['st', '1-0', 'f', 'v', 'g', 'w'], ['st', '1-0', 'f', R, 'g', R]],
    ['PUBLISH', ['chan', 'payload'], ['chan', R]],
    ['EVAL', ['return 1', 2, 'k1', 'k2', 'argv1'], [R, 2, 'k1', 'k2', R]],
    ['EVALSHA', ['abc123', 1, 'k1', 'argv1', 'argv2'], ['abc123', 1, 'k1', R, R]],
    ['GET', ['k'], ['k']],
    ['MGET', ['a', 'b'], ['a', 'b']],
    ['DEL', ['a', 'b'], ['a', 'b']],
    ['EXPIRE', ['k', 30], ['k', 30]],
    ['LRANGE', ['l', 0, -1], ['l', 0, -1]],
    ['BLPOP', ['a', 'b', 5], ['a', 'b', 5]],
    ['AUTH', ['user', 'pass'], [R, R]],
    ['CONFIG', ['SET', 'requirepass', 'x'], [R, R, R]],
    ['SOMEFUTURECMD', ['k', 'v'], ['k', R]],
  ])('%s %j', (command, args, expected) => {
    expect(redactRedisArgs(command, args)).toEqual(expected);
  });

  it('records a Buffer key by its size and never a Buffer value', () => {
    expect(redactRedisArgs('SET', [Buffer.from('key'), Buffer.from('secret')])).toEqual([
      '[Buffer 3 bytes]',
      R,
    ]);
  });

  it('keeps the argument count (the shape of the command)', () => {
    expect(redactRedisArgs('LPUSH', ['l', ...Array.from({ length: 10 }, String)])).toHaveLength(11);
  });
});
