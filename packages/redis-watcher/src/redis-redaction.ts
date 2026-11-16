// packages/redis-watcher/src/redis-redaction.ts
//
// What a recorded redis command keeps by default: its name, its keys, and the
// arguments that only shape it (TTLs, flags, ranges, counts). Every other argument
// is a VALUE (what SET stores, what PUBLISH sends, what LPUSH pushes, a script's
// ARGV, a password) and is replaced with `[REDACTED]`, keeping its position so the
// shape and count of the command still read. Replies are never recorded.
//
// The trigger: a session store's `SET <session-key> <session json>` put csrf
// secrets and refresh tokens into the telemetry verbatim.

/** What replaces a value argument. */
export const REDIS_REDACTED = '[REDACTED]';

/** How an argument is recorded: `key` (kept, rendered), `keep` (kept: a flag, a TTL, a
 *  range), `value` (replaced with {@link REDIS_REDACTED}). */
type ArgKind = 'key' | 'keep' | 'value';

/** Classifies the arguments of one command, by position. */
type Classifier = (args: readonly unknown[]) => ArgKind[];

const fill = (length: number, kind: ArgKind): ArgKind[] => Array.from({ length }, () => kind);

/** The first argument is the key; the rest is `rest`. */
const firstKey =
  (rest: ArgKind): Classifier =>
  (args) =>
    args.map((_, index) => (index === 0 ? 'key' : rest));

/** The first argument is the key, the next `values` arguments are values, the rest kept. */
const keyThenValues =
  (values: number, offset = 1): Classifier =>
  (args) =>
    args.map((_, index) =>
      index === 0 ? 'key' : index >= offset && index < offset + values ? 'value' : 'keep',
    );

/** Every argument is a key. */
const allKeys: Classifier = (args) => fill(args.length, 'key');

/** Every argument is a key except the last (a blocking command's timeout). */
const keysThenTimeout: Classifier = (args) =>
  args.map((_, index) => (index === args.length - 1 ? 'keep' : 'key'));

/** The first `n` arguments are keys, the rest `rest`. */
const firstKeys =
  (n: number, rest: ArgKind): Classifier =>
  (args) =>
    args.map((_, index) => (index < n ? 'key' : rest));

/** `key value key value …` (MSET). */
const keyValuePairs: Classifier = (args) =>
  args.map((_, index) => (index % 2 === 0 ? 'key' : 'value'));

/** `key field value field value …` (HSET): fields name the shape, values are redacted. */
const keyFieldValuePairs: Classifier = (args) =>
  args.map((_, index) => (index === 0 ? 'key' : index % 2 === 1 ? 'keep' : 'value'));

/** No argument is kept (AUTH, HELLO, CONFIG SET, MIGRATE …: they may carry credentials). */
const nothing: Classifier = (args) => fill(args.length, 'value');

/** Every argument is kept (no key, no value: PING, SCAN, INFO …). */
const everything: Classifier = (args) => fill(args.length, 'keep');

/** `script|sha numkeys key… arg…` (EVAL, EVALSHA, FCALL): the keys kept, ARGV redacted. */
const scriptCall =
  (keepScript: boolean): Classifier =>
  (args) => {
    const numKeys = Number(args[1]);
    const keyCount = Number.isInteger(numKeys) && numKeys >= 0 ? numKeys : 0;
    return args.map((_, index) => {
      if (index === 0) return keepScript ? 'keep' : 'value';
      if (index === 1) return 'keep';
      return index < 2 + keyCount ? 'key' : 'value';
    });
  };

/** `ZADD key [NX|XX|GT|LT|CH|INCR]… score member …`: scores kept, members redacted. */
const zadd: Classifier = (args) => {
  const kinds: ArgKind[] = ['key'];
  let index = 1;
  while (
    index < args.length &&
    typeof args[index] === 'string' &&
    /^(nx|xx|gt|lt|ch|incr)$/i.test(args[index] as string)
  ) {
    kinds.push('keep');
    index += 1;
  }
  for (let pair = 0; index < args.length; index += 1, pair += 1) {
    kinds.push(pair % 2 === 0 ? 'keep' : 'value');
  }
  return kinds;
};

/** `XADD key [NOMKSTREAM] [MAXLEN|MINID [=|~] threshold [LIMIT n]] id|* field value …`. */
const xadd: Classifier = (args) => {
  // Options up to (and including) the id: everything before the first field.
  for (let index = 1; index < args.length; index += 1) {
    const arg = String(args[index]);
    const previous = String(args[index - 1] ?? '').toLowerCase();
    // The id, unless it is a MAXLEN/MINID threshold or a LIMIT count.
    if (
      (arg === '*' || /^\d+(-\d+|-\*)?$/.test(arg)) &&
      !['maxlen', 'minid', '=', '~', 'limit'].includes(previous)
    ) {
      return args.map((_, i) =>
        i === 0 ? 'key' : i <= index ? 'keep' : (i - index) % 2 === 1 ? 'keep' : 'value',
      );
    }
  }
  // No id found: keep the key, redact the rest.
  return args.map((_, i) => (i === 0 ? 'key' : 'value'));
};

/** `SET key value [EX s|PX ms|…] [NX|XX] [GET]`. */
const set = keyThenValues(1);

const CLASSIFIERS: Record<string, Classifier> = {
  // Strings.
  SET: set,
  SETNX: keyThenValues(1),
  SETEX: keyThenValues(1, 2),
  PSETEX: keyThenValues(1, 2),
  GETSET: keyThenValues(1),
  APPEND: keyThenValues(1),
  SETRANGE: keyThenValues(1, 2),
  MSET: keyValuePairs,
  MSETNX: keyValuePairs,
  GET: firstKey('keep'),
  GETDEL: firstKey('keep'),
  GETEX: firstKey('keep'),
  GETRANGE: firstKey('keep'),
  STRLEN: firstKey('keep'),
  INCR: firstKey('keep'),
  INCRBY: firstKey('keep'),
  INCRBYFLOAT: firstKey('keep'),
  DECR: firstKey('keep'),
  DECRBY: firstKey('keep'),
  MGET: allKeys,
  // Keys.
  DEL: allKeys,
  UNLINK: allKeys,
  EXISTS: allKeys,
  TOUCH: allKeys,
  WATCH: allKeys,
  EXPIRE: firstKey('keep'),
  PEXPIRE: firstKey('keep'),
  EXPIREAT: firstKey('keep'),
  PEXPIREAT: firstKey('keep'),
  PERSIST: firstKey('keep'),
  TTL: firstKey('keep'),
  PTTL: firstKey('keep'),
  TYPE: firstKey('keep'),
  RENAME: firstKeys(2, 'keep'),
  RENAMENX: firstKeys(2, 'keep'),
  COPY: firstKeys(2, 'keep'),
  DUMP: firstKey('keep'),
  RESTORE: keyThenValues(1, 2),
  // Hashes.
  HSET: keyFieldValuePairs,
  HMSET: keyFieldValuePairs,
  HSETNX: keyFieldValuePairs,
  HGET: firstKey('keep'),
  HMGET: firstKey('keep'),
  HDEL: firstKey('keep'),
  HEXISTS: firstKey('keep'),
  HGETALL: firstKey('keep'),
  HKEYS: firstKey('keep'),
  HVALS: firstKey('keep'),
  HLEN: firstKey('keep'),
  HINCRBY: firstKey('keep'),
  HINCRBYFLOAT: firstKey('keep'),
  HSCAN: firstKey('keep'),
  // Lists.
  LPUSH: firstKey('value'),
  RPUSH: firstKey('value'),
  LPUSHX: firstKey('value'),
  RPUSHX: firstKey('value'),
  LSET: keyThenValues(1, 2),
  LINSERT: (args) => args.map((_, i) => (i === 0 ? 'key' : i === 1 ? 'keep' : 'value')),
  LREM: keyThenValues(1, 2),
  LPOS: keyThenValues(1),
  LPOP: firstKey('keep'),
  RPOP: firstKey('keep'),
  LRANGE: firstKey('keep'),
  LLEN: firstKey('keep'),
  LINDEX: firstKey('keep'),
  LTRIM: firstKey('keep'),
  RPOPLPUSH: firstKeys(2, 'keep'),
  LMOVE: firstKeys(2, 'keep'),
  BLMOVE: firstKeys(2, 'keep'),
  BRPOPLPUSH: firstKeys(2, 'keep'),
  BLPOP: keysThenTimeout,
  BRPOP: keysThenTimeout,
  // Sets.
  SADD: firstKey('value'),
  SREM: firstKey('value'),
  SISMEMBER: firstKey('value'),
  SMISMEMBER: firstKey('value'),
  SMOVE: (args) => args.map((_, i) => (i < 2 ? 'key' : 'value')),
  SMEMBERS: firstKey('keep'),
  SCARD: firstKey('keep'),
  SPOP: firstKey('keep'),
  SRANDMEMBER: firstKey('keep'),
  SSCAN: firstKey('keep'),
  SINTER: allKeys,
  SUNION: allKeys,
  SDIFF: allKeys,
  SINTERSTORE: allKeys,
  SUNIONSTORE: allKeys,
  SDIFFSTORE: allKeys,
  // Sorted sets.
  ZADD: zadd,
  ZINCRBY: (args) => args.map((_, i) => (i === 0 ? 'key' : i === 1 ? 'keep' : 'value')),
  ZREM: firstKey('value'),
  ZSCORE: firstKey('value'),
  ZMSCORE: firstKey('value'),
  ZRANK: keyThenValues(1),
  ZREVRANK: keyThenValues(1),
  ZRANGE: firstKey('keep'),
  ZREVRANGE: firstKey('keep'),
  ZRANGEBYSCORE: firstKey('keep'),
  ZREVRANGEBYSCORE: firstKey('keep'),
  ZRANGEBYLEX: firstKey('keep'),
  ZCARD: firstKey('keep'),
  ZCOUNT: firstKey('keep'),
  ZREMRANGEBYSCORE: firstKey('keep'),
  ZREMRANGEBYRANK: firstKey('keep'),
  ZPOPMIN: firstKey('keep'),
  ZPOPMAX: firstKey('keep'),
  ZSCAN: firstKey('keep'),
  BZPOPMIN: keysThenTimeout,
  BZPOPMAX: keysThenTimeout,
  // HyperLogLog, geo, streams.
  PFADD: firstKey('value'),
  PFCOUNT: allKeys,
  GEOADD: firstKey('value'),
  XADD: xadd,
  XLEN: firstKey('keep'),
  XRANGE: firstKey('keep'),
  XREVRANGE: firstKey('keep'),
  XDEL: firstKey('keep'),
  XTRIM: firstKey('keep'),
  XACK: firstKey('keep'),
  XREAD: everything,
  XREADGROUP: everything,
  XGROUP: everything,
  // Pub/sub.
  PUBLISH: keyThenValues(1),
  SPUBLISH: keyThenValues(1),
  SUBSCRIBE: allKeys,
  PSUBSCRIBE: allKeys,
  UNSUBSCRIBE: allKeys,
  PUNSUBSCRIBE: allKeys,
  // Scripts.
  EVAL: scriptCall(false),
  EVAL_RO: scriptCall(false),
  EVALSHA: scriptCall(true),
  EVALSHA_RO: scriptCall(true),
  FCALL: scriptCall(true),
  FCALL_RO: scriptCall(true),
  SCRIPT: (args) => args.map((_, i) => (i === 0 ? 'keep' : 'value')),
  // Server/connection: nothing sensitive.
  PING: nothing,
  ECHO: nothing,
  SCAN: everything,
  KEYS: everything,
  INFO: everything,
  SELECT: everything,
  DBSIZE: everything,
  TIME: everything,
  MULTI: everything,
  EXEC: everything,
  DISCARD: everything,
  UNWATCH: everything,
  QUIT: everything,
  READONLY: everything,
  CLUSTER: everything,
  COMMAND: everything,
  // May carry credentials: record the command name and argument count only.
  AUTH: nothing,
  HELLO: nothing,
  CONFIG: nothing,
  MIGRATE: nothing,
  ACL: nothing,
  CLIENT: nothing,
};

/** A key as recorded: a string as is, a Buffer as its size (it may be binary). */
function renderKey(arg: unknown): unknown {
  if (typeof arg === 'string' || typeof arg === 'number') return arg;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(arg)) return `[Buffer ${arg.length} bytes]`;
  return String(arg);
}

/** A kept argument (a flag, a TTL, a range) as recorded; never an object or a buffer. */
function renderKept(arg: unknown): unknown {
  if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return arg;
  if (typeof arg === 'bigint') return arg.toString();
  return REDIS_REDACTED;
}

/**
 * The arguments of `command` as recorded by default: keys and shaping arguments kept, values
 * replaced with {@link REDIS_REDACTED} in place. An unknown command keeps its first argument (the
 * key, for almost every redis command) and redacts the rest.
 */
export function redactRedisArgs(command: string, args: readonly unknown[]): unknown[] {
  const classify = CLASSIFIERS[command.toUpperCase()] ?? firstKey('value');
  const kinds = classify(args);
  return args.map((arg, index) => {
    const kind = kinds[index] ?? 'value';
    if (kind === 'key') return renderKey(arg);
    if (kind === 'keep') return renderKept(arg);
    return REDIS_REDACTED;
  });
}
