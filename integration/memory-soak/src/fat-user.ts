// integration/memory-soak/src/fat-user.ts
//
// A synthetic stand-in for the host's authenticated `req.user`: a CLASS INSTANCE
// (not a plain object) whose enumerable own-property graph is intentionally fat
// (~10-30 KB serialized) and CIRCULAR, exactly like a hydrated MikroORM entity
// graph (user -> base -> users[] back-references, lazy-ish nested relations).
//
// This is the object the request middleware reads via `req.user` and the
// Recorder deep-clones through redact(). It exists to reproduce the incident's
// "entries can be tens of KB" condition under load.

/** A nested relation row carried on the fat user (mimics an ORM child entity). */
export class SoakBaseEntity {
  id: string;
  name: string;
  region: string;
  /** Back-reference to the owning users — the source of the circular graph. */
  users: SoakUserEntity[] = [];
  /** Padding to push each base into the multi-KB range like a real row. */
  metadata: Record<string, string>;

  constructor(id: string, name: string) {
    this.id = id;
    this.name = name;
    this.region = 'us-east-1';
    this.metadata = buildPadding(`base-${id}`, 24);
  }
}

/** A class instance shaped like a hydrated authenticated user entity. */
export class SoakUserEntity {
  id: string;
  email: string;
  name: string;
  role: string;
  // Sensitive fields so redact() has real work to do on the hot path.
  password: string;
  token: string;
  refresh_token: string;
  permissions: string[];
  base: SoakBaseEntity;
  /** Self-reference, like an ORM entity that points back at itself via a relation. */
  self: SoakUserEntity | null = null;
  metadata: Record<string, string>;

  constructor(id: string, base: SoakBaseEntity) {
    this.id = id;
    this.email = `user-${id}@example.com`;
    this.name = `User ${id}`;
    this.role = 'ADMIN';
    this.password = 'super-secret-password-value';
    this.token = `tok_${id}_${'x'.repeat(64)}`;
    this.refresh_token = `rt_${id}_${'y'.repeat(64)}`;
    this.permissions = Array.from({ length: 40 }, (_, index) => `perm:resource:${index}`);
    this.base = base;
    this.metadata = buildPadding(`user-${id}`, 64);
  }
}

/** Build a wide string map so the serialized graph lands in the multi-KB range. */
function buildPadding(seed: string, fields: number): Record<string, string> {
  const padding: Record<string, string> = {};
  for (let index = 0; index < fields; index += 1) {
    padding[`${seed}_field_${index}`] = `${seed}-${index}-${'p'.repeat(48)}`;
  }
  return padding;
}

/**
 * Build a fresh fat user per request (the host creates a new hydrated entity per
 * request too). The graph is circular: user.base.users[] contains the user, and
 * user.self === user. redact() must walk all of it.
 */
export function buildFatUser(requestIndex: number): SoakUserEntity {
  const base = new SoakBaseEntity(`b${requestIndex % 8}`, 'Soak Base');
  const user = new SoakUserEntity(`u${requestIndex}`, base);
  user.self = user;
  base.users.push(user);
  // A couple of sibling users on the base widen the graph the way a real
  // base->users collection would when eagerly loaded.
  base.users.push(new SoakUserEntity(`u${requestIndex}-sib1`, base));
  base.users.push(new SoakUserEntity(`u${requestIndex}-sib2`, base));
  return user;
}
