// Regression guard for a bug that reached production: `UpdateMemberEventPreferences` was
// declared as a `Schema.Class` while all 81 other request payloads in this API are
// `Schema.Struct`.
//
// Why that broke: the HTTP API client ENCODES the payload before it issues the request. A
// Class schema does not accept the plain object literal every call site passes, so encoding
// failed, the effect errored, and NO network request was ever sent. The user saw a generic
// "couldn't save" toast with an empty Network tab — which reads as a server fault and is not
// one. Nothing caught it: the web test mocks the API client (so encoding never runs) and the
// server integration test invokes the handler with an already-decoded payload.
//
// These tests exercise the encode direction with plain objects, which is what the client
// actually does.

import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import * as TeamApi from '~/api/TeamApi.js';

describe('UpdateMemberEventPreferences — encodes the plain object the client sends', () => {
  it('encodes a plain object literal (fails against a Schema.Class payload)', () => {
    const payload = {
      showAttendeeList: false,
      rsvpDmsTraining: true,
      rsvpDmsTournament: false,
      rsvpDmsOther: true,
      personalChannelsSplit: true,
    };
    expect(Schema.encodeSync(TeamApi.UpdateMemberEventPreferences)(payload)).toEqual(payload);
  });

  it('rejects the legacy payload a web build from before the bucket split sends', () => {
    const legacy = { showAttendeeList: true, rsvpReminderDms: false, personalChannelsSplit: false };
    expect(() => Schema.decodeUnknownSync(TeamApi.UpdateMemberEventPreferences)(legacy)).toThrow();
  });

  it('round-trips every boolean combination', () => {
    for (const showAttendeeList of [true, false]) {
      for (const rsvpDmsTournament of [true, false]) {
        for (const personalChannelsSplit of [true, false]) {
          const payload = {
            showAttendeeList,
            rsvpDmsTraining: !rsvpDmsTournament,
            rsvpDmsTournament,
            rsvpDmsOther: true,
            personalChannelsSplit,
          };
          const decoded = Schema.decodeUnknownSync(TeamApi.UpdateMemberEventPreferences)(
            Schema.encodeSync(TeamApi.UpdateMemberEventPreferences)(payload),
          );
          expect(decoded).toEqual(payload);
        }
      }
    }
  });

  it('rejects a non-boolean field rather than silently coercing it', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamApi.UpdateMemberEventPreferences)({
        showAttendeeList: 'yes',
        rsvpDmsTraining: true,
        rsvpDmsTournament: true,
        rsvpDmsOther: true,
        personalChannelsSplit: false,
      }),
    ).toThrow();
  });

  it('does NOT carry personalChannelsAvailable — that field is response-only', () => {
    // personalChannelsAvailable is response-only. Keeping that field
    // out of the payload is what stops a client from claiming a team-level capability.
    const keys = Object.keys(TeamApi.UpdateMemberEventPreferences.fields).sort();
    expect(keys).toEqual([
      'personalChannelsSplit',
      'rsvpDmsOther',
      'rsvpDmsTournament',
      'rsvpDmsTraining',
      'showAttendeeList',
    ]);
  });
});
