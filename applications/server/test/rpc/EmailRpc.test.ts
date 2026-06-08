import { it as itEffect } from '@effect/vitest';
import type { Discord, EmailForwarding, Team, TeamMember } from '@sideline/domain';
import { EmailRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { EmailRpcLive } from '~/rpc/email/index.js';
import { EmailApprovalService } from '~/services/EmailApprovalService.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000020' as Team.TeamId;

const COACH_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const NON_COACH_DISCORD_ID = '333333333333333333' as Discord.Snowflake;

const COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const NON_COACH_MEMBER_ID = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;

const EMAIL_PENDING = '11111111-1111-1111-1111-111111111111' as EmailForwarding.EmailMessageId;
const EMAIL_APPROVED = '22222222-2222-2222-2222-222222222222' as EmailForwarding.EmailMessageId;
const BOGUS_EMAIL_ID = '99999999-9999-9999-9999-999999999999' as EmailForwarding.EmailMessageId;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type EmailRecord = {
  id: EmailForwarding.EmailMessageId;
  team_id: string;
  status: EmailForwarding.EmailStatus;
  from_address: string;
  subject: string;
  body: string;
  summary: Option.Option<string>;
  summarize_attempts: number;
  last_error: Option.Option<string>;
  approval_request_message_id: Option.Option<string>;
  approved_by: Option.Option<string>;
  rejected_by: Option.Option<string>;
  posted_channel_id: Option.Option<string>;
  received_at: DateTime.Utc;
  created_at: DateTime.Utc;
  updated_at: DateTime.Utc;
};

let emailStore: Map<EmailForwarding.EmailMessageId, EmailRecord>;
let enqueuedEvents: Array<{ emailId: EmailForwarding.EmailMessageId; kind: string }>;

const now = DateTime.makeUnsafe('2024-01-01T00:00:00Z');

const makeEmailRecord = (
  id: EmailForwarding.EmailMessageId,
  overrides: Partial<EmailRecord> = {},
): EmailRecord => ({
  id,
  team_id: TEAM_ID,
  status: 'pending_approval',
  from_address: 'sender@example.com',
  subject: 'Team Update',
  body: 'Email body',
  summary: Option.some('AI summary'),
  summarize_attempts: 1,
  last_error: Option.none(),
  approval_request_message_id: Option.none(),
  approved_by: Option.none(),
  rejected_by: Option.none(),
  posted_channel_id: Option.none(),
  received_at: now,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const resetStores = () => {
  emailStore = new Map();
  enqueuedEvents = [];

  emailStore.set(EMAIL_PENDING, makeEmailRecord(EMAIL_PENDING, { status: 'pending_approval' }));
  emailStore.set(EMAIL_APPROVED, makeEmailRecord(EMAIL_APPROVED, { status: 'approved' }));
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockEmailMessagesRepository = () =>
  Layer.succeed(EmailMessagesRepository, {
    _tag: 'api/EmailMessagesRepository' as const,
    insertReceived: () => Effect.die(new Error('not implemented')),
    findById: (id: EmailForwarding.EmailMessageId) => {
      const row = emailStore.get(id);
      return Effect.succeed(row ? Option.some(row) : Option.none());
    },
    findReceivedBatch: () => Effect.succeed([]),
    claimForSummarizing: () => Effect.succeed(Option.none()),
    setSummaryPendingApproval: () => Effect.void,
    updateSummary: () => Effect.succeed(Option.none()),
    incrementAttemptsAndMaybeFail: () => Effect.void,
    approve: (id: EmailForwarding.EmailMessageId, _by: string) => {
      const row = emailStore.get(id);
      if (row?.status !== 'pending_approval') return Effect.succeed(Option.none());
      emailStore.set(id, { ...row, status: 'approved', approved_by: Option.some(_by) });
      return Effect.succeed(Option.some(id));
    },
    sendOriginal: (id: EmailForwarding.EmailMessageId, _by: string) => {
      const row = emailStore.get(id);
      if (row?.status !== 'pending_approval') return Effect.succeed(Option.none());
      emailStore.set(id, { ...row, status: 'send_original', approved_by: Option.some(_by) });
      return Effect.succeed(Option.some(id));
    },
    dismiss: (id: EmailForwarding.EmailMessageId, _by: string) => {
      const row = emailStore.get(id);
      if (row?.status !== 'pending_approval') return Effect.succeed(Option.none());
      emailStore.set(id, { ...row, status: 'rejected', rejected_by: Option.some(_by) });
      return Effect.succeed(Option.some(id));
    },
    setPosted: () => Effect.void,
  } as never);

const makeMockEmailPostSyncEventsRepository = () =>
  Layer.succeed(EmailPostSyncEventsRepository, {
    _tag: 'api/EmailPostSyncEventsRepository' as const,
    enqueue: (emailId: EmailForwarding.EmailMessageId, _teamId: string, kind: string) => {
      enqueuedEvents.push({ emailId, kind });
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as never);

const makeMockTeamMembersRepository = () =>
  Layer.succeed(TeamMembersRepository, {
    _tag: 'api/TeamMembersRepository' as const,
    addMember: () => Effect.die(new Error('Not implemented')),
    findById: () => Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: () => Effect.succeed([]),
    findRosterMemberByIds: () => Effect.succeed(Option.none()),
    findTeamMembersWithNames: () => Effect.succeed([]),
    deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
    reactivateMember: () => Effect.void,
    getPlayerRoleId: () => Effect.succeed(Option.none()),
    assignRole: () => Effect.void,
    unassignRole: () => Effect.void,
    setJerseyNumber: () => Effect.void,
    findMembershipByIds: () => Effect.succeed(Option.none()),
    findMembershipByDiscordAndTeam: (discordId: Discord.Snowflake, teamId: Team.TeamId) => {
      if (discordId === COACH_DISCORD_ID && teamId === TEAM_ID) {
        return Effect.succeed(
          Option.some({
            id: COACH_MEMBER_ID,
            team_id: TEAM_ID,
            user_id: 'user-coach',
            active: true,
            role_names: ['Coach'],
            permissions: ['team:manage'] as any,
          } as unknown as MembershipWithRole),
        );
      }
      if (discordId === NON_COACH_DISCORD_ID && teamId === TEAM_ID) {
        return Effect.succeed(
          Option.some({
            id: NON_COACH_MEMBER_ID,
            team_id: TEAM_ID,
            user_id: 'user-non-coach',
            active: true,
            role_names: ['Player'],
            permissions: [] as any,
          } as unknown as MembershipWithRole),
        );
      }
      return Effect.succeed(Option.none<MembershipWithRole>());
    },
  } as never);

const buildRpcTestLayer = () => {
  const mockMessagesRepo = makeMockEmailMessagesRepository();
  const mockSyncEventsRepo = makeMockEmailPostSyncEventsRepository();
  const approvalServiceLayer = EmailApprovalService.Default.pipe(
    Layer.provide(mockMessagesRepo),
    Layer.provide(mockSyncEventsRepo),
  );
  return EmailRpcLive.pipe(
    Layer.provide(mockMessagesRepo),
    Layer.provide(mockSyncEventsRepo),
    Layer.provide(makeMockTeamMembersRepository()),
    Layer.provide(approvalServiceLayer),
  );
};

// Helper to call Email/RecordApproval
const callRecordApproval = (params: {
  team_id: Team.TeamId;
  email_id: EmailForwarding.EmailMessageId;
  discord_user_id: Discord.Snowflake;
}) => {
  const layer = buildRpcTestLayer();
  return Effect.scoped(
    (RpcTest.makeClient(EmailRpcGroup.EmailRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) => rpc['Email/RecordApproval'](params) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

// Helper to call Email/RecordSendOriginal
const callRecordSendOriginal = (params: {
  team_id: Team.TeamId;
  email_id: EmailForwarding.EmailMessageId;
  discord_user_id: Discord.Snowflake;
}) => {
  const layer = buildRpcTestLayer();
  return Effect.scoped(
    (RpcTest.makeClient(EmailRpcGroup.EmailRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) => rpc['Email/RecordSendOriginal'](params) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

// Helper to call Email/RecordReject
const callRecordReject = (params: {
  team_id: Team.TeamId;
  email_id: EmailForwarding.EmailMessageId;
  discord_user_id: Discord.Snowflake;
}) => {
  const layer = buildRpcTestLayer();
  return Effect.scoped(
    (RpcTest.makeClient(EmailRpcGroup.EmailRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) => rpc['Email/RecordReject'](params) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(layer)) as Effect.Effect<any, any, never>;
};

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// RecordApproval — happy path
// ---------------------------------------------------------------------------

describe('Email/RecordApproval — authorized coach + pending email', () => {
  itEffect.effect('returns { outcome: approved } and enqueues post_summary', () =>
    callRecordApproval({
      team_id: TEAM_ID,
      email_id: EMAIL_PENDING,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.outcome).toBe('approved');
          const row = emailStore.get(EMAIL_PENDING);
          expect(row?.status).toBe('approved');
          const postSummaryEvents = enqueuedEvents.filter((e) => e.kind === 'post_summary');
          expect(postSummaryEvents).toHaveLength(1);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordApproval — already handled (idempotency)
// ---------------------------------------------------------------------------

describe('Email/RecordApproval — already approved (second call)', () => {
  itEffect.effect('returns { outcome: already_handled } with no duplicate enqueue', () =>
    callRecordApproval({
      team_id: TEAM_ID,
      email_id: EMAIL_APPROVED,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.outcome).toBe('already_handled');
          // No post_summary should be enqueued for already-approved email
          expect(enqueuedEvents.filter((e) => e.kind === 'post_summary')).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordApproval — non-coach user
// ---------------------------------------------------------------------------

describe('Email/RecordApproval — non-coach discord user', () => {
  itEffect.effect('fails with EmailApprovalForbidden', () =>
    callRecordApproval({
      team_id: TEAM_ID,
      email_id: EMAIL_PENDING,
      discord_user_id: NON_COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailApprovalForbidden');
            // Email should still be pending — no state change
            expect(emailStore.get(EMAIL_PENDING)?.status).toBe('pending_approval');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordApproval — non-member discord user
// ---------------------------------------------------------------------------

describe('Email/RecordApproval — non-member discord user (not in team)', () => {
  itEffect.effect('fails with EmailApprovalForbidden when user has no membership', () =>
    callRecordApproval({
      team_id: TEAM_ID,
      email_id: EMAIL_PENDING,
      discord_user_id: '999999999999999999' as Discord.Snowflake,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailApprovalForbidden');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordApproval — unknown email id
// ---------------------------------------------------------------------------

describe('Email/RecordApproval — unknown email id', () => {
  itEffect.effect('fails with EmailRpcMessageNotFound', () =>
    callRecordApproval({
      team_id: TEAM_ID,
      email_id: BOGUS_EMAIL_ID,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailRpcMessageNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordApproval — email belongs to different team
// ---------------------------------------------------------------------------

describe('Email/RecordApproval — email belongs to different team', () => {
  itEffect.effect('fails with EmailRpcMessageNotFound when team_id does not match', () =>
    callRecordApproval({
      team_id: OTHER_TEAM_ID,
      email_id: EMAIL_PENDING,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailRpcMessageNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordSendOriginal — happy path
// ---------------------------------------------------------------------------

describe('Email/RecordSendOriginal — authorized coach + pending email', () => {
  itEffect.effect(
    'returns { outcome: sent_original }, status=send_original, enqueues post_original',
    () =>
      callRecordSendOriginal({
        team_id: TEAM_ID,
        email_id: EMAIL_PENDING,
        discord_user_id: COACH_DISCORD_ID,
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.outcome).toBe('sent_original');
            const row = emailStore.get(EMAIL_PENDING);
            expect(row?.status).toBe('send_original');
            const postOriginalEvents = enqueuedEvents.filter((e) => e.kind === 'post_original');
            expect(postOriginalEvents).toHaveLength(1);
          }),
        ),
        Effect.asVoid,
      ),
  );
});

// ---------------------------------------------------------------------------
// RecordSendOriginal — already handled (idempotency)
// ---------------------------------------------------------------------------

describe('Email/RecordSendOriginal — already approved email', () => {
  itEffect.effect('returns { outcome: already_handled } and enqueues nothing', () =>
    callRecordSendOriginal({
      team_id: TEAM_ID,
      email_id: EMAIL_APPROVED,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.outcome).toBe('already_handled');
          expect(enqueuedEvents.filter((e) => e.kind === 'post_original')).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordSendOriginal — non-coach user
// ---------------------------------------------------------------------------

describe('Email/RecordSendOriginal — non-coach discord user', () => {
  itEffect.effect('fails with EmailApprovalForbidden', () =>
    callRecordSendOriginal({
      team_id: TEAM_ID,
      email_id: EMAIL_PENDING,
      discord_user_id: NON_COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailApprovalForbidden');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordSendOriginal — unknown email id
// ---------------------------------------------------------------------------

describe('Email/RecordSendOriginal — unknown email id', () => {
  itEffect.effect('fails with EmailRpcMessageNotFound', () =>
    callRecordSendOriginal({
      team_id: TEAM_ID,
      email_id: BOGUS_EMAIL_ID,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailRpcMessageNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordReject (dismiss) — happy path
// ---------------------------------------------------------------------------

describe('Email/RecordReject — authorized coach + pending email', () => {
  itEffect.effect('returns { outcome: dismissed }, status=rejected, ZERO events enqueued', () =>
    callRecordReject({
      team_id: TEAM_ID,
      email_id: EMAIL_PENDING,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.outcome).toBe('dismissed');
          const row = emailStore.get(EMAIL_PENDING);
          expect(row?.status).toBe('rejected');
          // dismiss does NOT enqueue any sync events
          expect(enqueuedEvents).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordReject (dismiss) — already handled (idempotency)
// ---------------------------------------------------------------------------

describe('Email/RecordReject — already approved email', () => {
  itEffect.effect('returns { outcome: already_handled } and enqueues nothing', () =>
    callRecordReject({
      team_id: TEAM_ID,
      email_id: EMAIL_APPROVED,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.outcome).toBe('already_handled');
          expect(enqueuedEvents).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordReject — non-coach user
// ---------------------------------------------------------------------------

describe('Email/RecordReject — non-coach discord user', () => {
  itEffect.effect('fails with EmailApprovalForbidden', () =>
    callRecordReject({
      team_id: TEAM_ID,
      email_id: EMAIL_PENDING,
      discord_user_id: NON_COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailApprovalForbidden');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordReject — unknown email id
// ---------------------------------------------------------------------------

describe('Email/RecordReject — unknown email id', () => {
  itEffect.effect('fails with EmailRpcMessageNotFound', () =>
    callRecordReject({
      team_id: TEAM_ID,
      email_id: BOGUS_EMAIL_ID,
      discord_user_id: COACH_DISCORD_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as any;
            expect(err._tag).toBe('EmailRpcMessageNotFound');
          }
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// RecordApproval + RecordSendOriginal — concurrent race on same email
// ---------------------------------------------------------------------------

describe('Email/RecordApproval + RecordSendOriginal — concurrent race on same email', () => {
  itEffect.effect(
    'first caller wins, second returns already_handled, exactly one event enqueued',
    () => {
      // Approve first, then try sendOriginal
      return callRecordApproval({
        team_id: TEAM_ID,
        email_id: EMAIL_PENDING,
        discord_user_id: COACH_DISCORD_ID,
      }).pipe(
        Effect.flatMap((approveResult) =>
          callRecordSendOriginal({
            team_id: TEAM_ID,
            email_id: EMAIL_PENDING,
            discord_user_id: COACH_DISCORD_ID,
          }).pipe(
            Effect.tap((sendResult) =>
              Effect.sync(() => {
                expect(approveResult.outcome).toBe('approved');
                expect(sendResult.outcome).toBe('already_handled');
                // Status stays approved
                expect(emailStore.get(EMAIL_PENDING)?.status).toBe('approved');
                // Only one post event (post_summary from approve)
                expect(enqueuedEvents).toHaveLength(1);
                expect(enqueuedEvents[0].kind).toBe('post_summary');
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Dismiss-then-sendOriginal race — dismiss wins, zero events
// ---------------------------------------------------------------------------

describe('Email/RecordReject then RecordSendOriginal — dismiss wins', () => {
  itEffect.effect(
    'dismiss wins, sendOriginal returns already_handled, zero events enqueued',
    () => {
      return callRecordReject({
        team_id: TEAM_ID,
        email_id: EMAIL_PENDING,
        discord_user_id: COACH_DISCORD_ID,
      }).pipe(
        Effect.flatMap((dismissResult) =>
          callRecordSendOriginal({
            team_id: TEAM_ID,
            email_id: EMAIL_PENDING,
            discord_user_id: COACH_DISCORD_ID,
          }).pipe(
            Effect.tap((sendResult) =>
              Effect.sync(() => {
                expect(dismissResult.outcome).toBe('dismissed');
                expect(sendResult.outcome).toBe('already_handled');
                // Status stays rejected from dismiss
                expect(emailStore.get(EMAIL_PENDING)?.status).toBe('rejected');
                // Zero events — dismiss does not enqueue, sendOriginal found already handled
                expect(enqueuedEvents).toHaveLength(0);
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    },
  );
});
