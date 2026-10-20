import { randomUUID } from 'node:crypto';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/**
 * One hour of one type: the unit files are grouped, listed, compacted and expired by.
 * `hourStart` is the UTC epoch-ms the hour begins at.
 */
export interface Partition {
  type: string;
  hourStart: number;
}

/** `type=<type>/` — the prefix a lifecycle rule targets to give a type its own retention. */
export function typePrefix(type: string): string {
  return `type=${encodeURIComponent(type)}/`;
}

export function dayPrefix(type: string, dayStart: number): string {
  return `${typePrefix(type)}dt=${new Date(dayStart).toISOString().slice(0, 10)}/`;
}

export function hourPrefix(partition: Partition): string {
  const hour = String(new Date(partition.hourStart).getUTCHours()).padStart(2, '0');
  return `${dayPrefix(partition.type, floorDay(partition.hourStart))}hour=${hour}/`;
}

/** `type=<t>/dt=<yyyy-mm-dd>/hour=<hh>/<instanceId>-<uuid>.parquet` */
export function fileKey(partition: Partition, instanceId: string): string {
  const safeInstance = instanceId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${hourPrefix(partition)}${safeInstance}-${randomUUID()}.parquet`;
}

export function floorHour(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

export function floorDay(epochMs: number): number {
  return Math.floor(epochMs / DAY_MS) * DAY_MS;
}

/** The type named by a `type=<t>/` listing prefix, or null for anything else. */
export function parseTypePrefix(prefix: string): string | null {
  const match = /^type=([^/]+)\/$/.exec(prefix);
  return match?.[1] !== undefined ? decodeURIComponent(match[1]) : null;
}

/** The UTC day start named by a `type=<t>/dt=<yyyy-mm-dd>/` listing prefix, or null. */
export function parseDayPrefix(prefix: string): number | null {
  const match = /dt=(\d{4}-\d{2}-\d{2})\/$/.exec(prefix);
  if (match?.[1] === undefined) return null;
  const ms = Date.parse(`${match[1]}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The partition a file key belongs to, or null for a key outside the layout. */
export function parseFileKey(key: string): Partition | null {
  const match = /^type=([^/]+)\/dt=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\/[^/]+\.parquet$/.exec(key);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  const day = Date.parse(`${match[2]}T00:00:00Z`);
  if (Number.isNaN(day)) return null;
  return { type: decodeURIComponent(match[1]), hourStart: day + Number(match[3]) * HOUR_MS };
}

/**
 * The epoch-ms a UUIDv7 was generated at, or null for any other id. Telescope's entry and batch
 * ids are v7, which lets point lookups start at the hours an entry can be in instead of the
 * whole tier.
 */
export function uuidV7Time(id: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
