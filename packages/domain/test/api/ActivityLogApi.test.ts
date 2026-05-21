import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as ActivityLogApi from '~/api/ActivityLogApi.js';

const MOCK_TYPE_ID = '00000000-0000-0000-0000-000000000001';

describe('CreateActivityLogRequest', () => {
  it('decodes valid input with activityTypeId and null optional fields', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
      activityTypeId: MOCK_TYPE_ID,
      durationMinutes: null,
      note: null,
      loggedAtDate: null,
    });
    expect(result.activityTypeId).toBe(MOCK_TYPE_ID);
    expect(Option.isNone(result.durationMinutes)).toBe(true);
    expect(Option.isNone(result.note)).toBe(true);
  });

  it('decodes valid input with activityTypeId and provided optional fields', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
      activityTypeId: MOCK_TYPE_ID,
      durationMinutes: 45,
      note: 'Morning run',
      loggedAtDate: null,
    });
    expect(result.activityTypeId).toBe(MOCK_TYPE_ID);
    expect(Option.getOrNull(result.durationMinutes)).toBe(45);
    expect(Option.getOrNull(result.note)).toBe('Morning run');
  });

  it('rejects durationMinutes greater than 1440', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
        activityTypeId: MOCK_TYPE_ID,
        durationMinutes: 1441,
        note: null,
        loggedAtDate: null,
      }),
    ).toThrow();
  });

  it('rejects durationMinutes of exactly 0', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
        activityTypeId: MOCK_TYPE_ID,
        durationMinutes: 0,
        note: null,
        loggedAtDate: null,
      }),
    ).toThrow();
  });

  it('accepts durationMinutes of exactly 1440', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
      activityTypeId: MOCK_TYPE_ID,
      durationMinutes: 1440,
      note: null,
      loggedAtDate: null,
    });
    expect(Option.getOrNull(result.durationMinutes)).toBe(1440);
  });

  it('decodes loggedAtDate: null to Option.none()', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
      activityTypeId: MOCK_TYPE_ID,
      durationMinutes: null,
      note: null,
      loggedAtDate: null,
    });
    expect(Option.isNone(result.loggedAtDate)).toBe(true);
  });

  it("decodes loggedAtDate: '2026-05-15' to Option.some('2026-05-15')", () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
      activityTypeId: MOCK_TYPE_ID,
      durationMinutes: null,
      note: null,
      loggedAtDate: '2026-05-15',
    });
    expect(Option.isSome(result.loggedAtDate)).toBe(true);
    if (Option.isSome(result.loggedAtDate)) {
      expect(result.loggedAtDate.value).toBe('2026-05-15');
    }
  });

  it("rejects loggedAtDate: '2026-5-15' (missing zero-padding)", () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityLogApi.CreateActivityLogRequest)({
        activityTypeId: MOCK_TYPE_ID,
        durationMinutes: null,
        note: null,
        loggedAtDate: '2026-5-15',
      }),
    ).toThrow();
  });
});

describe('UpdateActivityLogRequest', () => {
  it('decodes partial input with only activityTypeId provided', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.UpdateActivityLogRequest)({
      activityTypeId: MOCK_TYPE_ID,
    });
    expect(Option.getOrNull(result.activityTypeId)).toBe(MOCK_TYPE_ID);
    expect(Option.isNone(result.durationMinutes)).toBe(true); // outer Option = absent
    expect(Option.isNone(result.note)).toBe(true); // outer Option = absent
  });

  it('decodes empty object with all fields None', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.UpdateActivityLogRequest)({});
    expect(Option.isNone(result.activityTypeId)).toBe(true);
    expect(Option.isNone(result.durationMinutes)).toBe(true);
    expect(Option.isNone(result.note)).toBe(true);
  });

  it('decodes full update with all fields provided', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.UpdateActivityLogRequest)({
      activityTypeId: MOCK_TYPE_ID,
      durationMinutes: 30,
      note: 'Updated note',
    });
    expect(Option.getOrNull(result.activityTypeId)).toBe(MOCK_TYPE_ID);
    expect(Option.isSome(result.durationMinutes)).toBe(true);
    if (Option.isSome(result.durationMinutes))
      expect(Option.getOrNull(result.durationMinutes.value)).toBe(30);
    expect(Option.isSome(result.note)).toBe(true);
    if (Option.isSome(result.note))
      expect(Option.getOrNull(result.note.value)).toBe('Updated note');
  });

  it('rejects durationMinutes greater than 1440 in update', () => {
    expect(() =>
      Schema.decodeUnknownSync(ActivityLogApi.UpdateActivityLogRequest)({
        durationMinutes: 1441,
      }),
    ).toThrow();
  });

  it('decodes absent loggedAtDate (omitted) to Option.none()', () => {
    const result = Schema.decodeUnknownSync(ActivityLogApi.UpdateActivityLogRequest)({});
    expect(Option.isNone(result.loggedAtDate)).toBe(true);
  });
});
