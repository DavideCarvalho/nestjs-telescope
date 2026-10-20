import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

/**
 * The structural slice of an AWS SDK v3 `S3Client` this package uses. Typed structurally so the
 * host's own client (any v3 version, any endpoint: GovCloud, a VPC endpoint, MinIO) is accepted
 * as-is and `@aws-sdk/client-s3` stays an optional peer.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

export interface S3LocationOptions {
  bucket: string;
  /** Key prefix every file lives under, without a trailing slash. Defaults to `telescope`. */
  prefix?: string;
  client: S3ClientLike;
}

export type ColdLocationOptions = { s3: S3LocationOptions } | { dir: string };

export interface StoredObject {
  /** Key relative to the location root, `/`-separated. */
  key: string;
  size: number;
}

export interface Listing {
  /** Direct children "directories" (with a trailing `/`) when listed with a delimiter. */
  prefixes: string[];
  objects: StoredObject[];
}

/** Where cold files live. Keys are relative to the location root and always `/`-separated. */
export interface ColdLocation {
  readonly describedAs: string;
  /** Objects under `prefix`; with `delimiter`, only its direct children. */
  list(prefix: string, delimiter?: boolean): Promise<Listing>;
  /** Bytes `[start, end)` of `key`. Throws {@link ObjectGoneError} when the key does not exist. */
  read(key: string, start: number, end: number): Promise<ArrayBuffer>;
  /** Writes `key` atomically: readers see the whole file or nothing. */
  write(key: string, bytes: Uint8Array): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** A local path for `key`, when the location is a directory. */
  localPath?(key: string): string;
}

/** A read hit a key that was deleted after it was listed — typically by compaction. */
export class ObjectGoneError extends Error {
  constructor(key: string) {
    super(`cold object ${key} no longer exists`);
    this.name = 'ObjectGoneError';
  }
}

export function resolveLocation(options: ColdLocationOptions): ColdLocation {
  return 's3' in options ? new S3Location(options.s3) : new DirLocation(options.dir);
}

class DirLocation implements ColdLocation {
  readonly describedAs: string;

  constructor(private readonly root: string) {
    this.describedAs = `dir ${root}`;
  }

  localPath(key: string): string {
    return join(this.root, ...key.split('/'));
  }

  async list(prefix: string, delimiter = false): Promise<Listing> {
    // Prefixes in this package always end at a path segment, so the prefix is a directory.
    const base = this.localPath(prefix);
    const listing: Listing = { prefixes: [], objects: [] };
    const walk = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const path = join(dir, name);
        const info = await stat(path).catch(() => null);
        if (info === null) continue;
        const key = relative(this.root, path).split(sep).join('/');
        if (info.isDirectory()) {
          if (delimiter) listing.prefixes.push(`${key}/`);
          else await walk(path);
        } else {
          listing.objects.push({ key, size: info.size });
        }
      }
    };
    await walk(base);
    return listing;
  }

  async read(key: string, start: number, end: number): Promise<ArrayBuffer> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(this.localPath(key), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectGoneError(key);
      throw error;
    }
    try {
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      return toArrayBuffer(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    // Written beside the target under a dot-name the lister skips, then renamed into place.
    const temp = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, bytes);
    await rename(temp, path);
  }

  async remove(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => rm(this.localPath(key), { force: true })));
  }
}

const DELETE_BATCH = 1000;

class S3Location implements ColdLocation {
  readonly describedAs: string;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly client: S3ClientLike;
  private commands: Promise<typeof import('@aws-sdk/client-s3')> | null = null;

  constructor(options: S3LocationOptions) {
    this.bucket = options.bucket;
    this.prefix = (options.prefix ?? 'telescope').replace(/^\/+|\/+$/g, '');
    this.client = options.client;
    this.describedAs = `s3://${this.bucket}/${this.prefix}`;
  }

  /** The command classes, from the same package the host built its client with. */
  private sdk(): Promise<typeof import('@aws-sdk/client-s3')> {
    this.commands ??= import('@aws-sdk/client-s3').catch((error: unknown) => {
      this.commands = null;
      throw new Error(
        `@dudousxd/nestjs-telescope-parquet: an S3 location needs @aws-sdk/client-s3 installed (${String(error)})`,
      );
    });
    return this.commands;
  }

  private full(key: string): string {
    return this.prefix === '' ? key : `${this.prefix}/${key}`;
  }

  private strip(key: string): string {
    return this.prefix === '' ? key : key.slice(this.prefix.length + 1);
  }

  async list(prefix: string, delimiter = false): Promise<Listing> {
    const { ListObjectsV2Command } = await this.sdk();
    const listing: Listing = { prefixes: [], objects: [] };
    let token: string | undefined;
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.full(prefix),
          ...(delimiter ? { Delimiter: '/' } : {}),
          ...(token !== undefined ? { ContinuationToken: token } : {}),
        }),
      )) as {
        Contents?: { Key?: string; Size?: number }[];
        CommonPrefixes?: { Prefix?: string }[];
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) {
          listing.objects.push({ key: this.strip(object.Key), size: object.Size ?? 0 });
        }
      }
      for (const common of page.CommonPrefixes ?? []) {
        if (common.Prefix !== undefined) listing.prefixes.push(this.strip(common.Prefix));
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return listing;
  }

  async read(key: string, start: number, end: number): Promise<ArrayBuffer> {
    if (end <= start) return new ArrayBuffer(0);
    const { GetObjectCommand } = await this.sdk();
    try {
      const response = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.full(key),
          Range: `bytes=${start}-${end - 1}`,
        }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (response.Body === undefined) return new ArrayBuffer(0);
      return toArrayBuffer(await response.Body.transformToByteArray());
    } catch (error) {
      const name = (error as { name?: string; Code?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') throw new ObjectGoneError(key);
      throw error;
    }
  }

  async write(key: string, bytes: Uint8Array): Promise<void> {
    const { PutObjectCommand } = await this.sdk();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        Body: bytes,
        ContentType: 'application/vnd.apache.parquet',
      }),
    );
  }

  async remove(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const { DeleteObjectsCommand } = await this.sdk();
    for (let index = 0; index < keys.length; index += DELETE_BATCH) {
      const chunk = keys.slice(index, index + DELETE_BATCH);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((key) => ({ Key: this.full(key) })), Quiet: true },
        }),
      );
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
