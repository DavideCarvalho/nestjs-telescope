import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_EVENT_TYPES,
  OFFICIAL_CHANNEL_NAMES,
  RESILIENCE_EVENT_TYPES,
  WORKFLOW_EVENT_TYPES,
} from './channels.js';

describe('official channel lists', () => {
  it('match the counts verified in the published tarballs', () => {
    expect(RESILIENCE_EVENT_TYPES).toHaveLength(9);
    expect(WORKFLOW_EVENT_TYPES).toHaveLength(19);
    expect(AUTHENTICATION_EVENT_TYPES).toHaveLength(13);
    expect(OFFICIAL_CHANNEL_NAMES.authorization).toEqual(['nestjs:authorization:denied']);
    expect(OFFICIAL_CHANNEL_NAMES.mail).toEqual(['nestjs:mail:sent', 'nestjs:mail:failed']);
  });

  it('are unique and prefixed nestjs:<lib>:', () => {
    const all = Object.entries(OFFICIAL_CHANNEL_NAMES).flatMap(([lib, names]) => {
      for (const name of names) expect(name.startsWith(`nestjs:${lib}:`)).toBe(true);
      return names;
    });
    expect(new Set(all).size).toBe(all.length);
  });
});
