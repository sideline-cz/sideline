/**
 * Single source of truth for `event_type` → personal-channel-bucket mapping
 * (Nastavitelná docházka, plan §3). Mirrors the `eventVisibleNow` /
 * `eventDayOrder` idiom in `eventVisibility.ts` — one SQL fragment module,
 * spliced with `sql.unsafe(...)` at every call site, so provisioning,
 * deprovisioning and `_listForEvent` routing can never drift apart.
 *
 * The DB value stays singular (`other`); only the rendered channel-name
 * suffix is plural (`others`) — that mapping lives in the bot's
 * `formatPersonalChannelName.ts`, not here.
 */

/**
 * SQL `CASE` mapping an event's type onto its bucket. `alias` is the events
 * table alias. Unknown/future `event_type` values fall into `other`, so a new
 * event type can never make an event invisible.
 */
export const eventBucketSql = (alias: string): string => `
  CASE ${alias}.event_type
    WHEN 'training' THEN 'training'
    WHEN 'match' THEN 'tournament'
    WHEN 'tournament' THEN 'tournament'
    ELSE 'other'
  END`;

/**
 * SQL array of the buckets a member SHOULD own, given their split preference.
 * `memberAlias` is the team_members table alias. The literals are pinned by
 * `PersonalChannelBucket` in `@sideline/domain` — keep the two in step.
 */
export const desiredBucketsSql = (memberAlias: string): string =>
  `CASE WHEN ${memberAlias}.personal_channels_split
        THEN ARRAY['training','tournament','other']
        ELSE ARRAY['all'] END`;

/**
 * SQL predicate: TRUE when some bucket the member SHOULD own has no provisioned
 * channel yet. `memberAlias` is the team_members alias; `teamIdExpr`/`memberIdExpr`
 * locate the member from the enclosing query (a channel row and a member row spell
 * those differently). The LEFT JOIN makes "no row at all" and "row reserved but
 * never provisioned" the same condition.
 */
export const missingDesiredBucketSql = (
  memberAlias: string,
  teamIdExpr: string,
  memberIdExpr: string,
): string => `
  EXISTS (
    SELECT 1
    FROM unnest(${desiredBucketsSql(memberAlias)}) AS want(bucket)
    LEFT JOIN personal_event_channels have
      ON have.team_id = ${teamIdExpr} AND have.team_member_id = ${memberIdExpr}
     AND have.bucket = want.bucket
    WHERE have.discord_channel_id IS NULL
  )`;

/**
 * SQL predicate: TRUE for a provisioned channel outside the member's desired bucket
 * set that is safe to tear down. `channelAlias` is the personal_event_channels alias.
 *
 * The second half is the B3 gate (plan §6.2/§12): do not tear an obsolete channel
 * down until every desired bucket is FULLY provisioned. Provision and deprovision run
 * in the SAME tick and provision swallows every failure, so without this guard a stuck
 * provision would leave a member with a partial set AND their old channel (plus its
 * message history) deleted. With it, a stuck provision degrades to "you keep the
 * channel you had".
 *
 * Shared between the deprovision query and the poll that wakes it so the poll can
 * never fire on a tick where deprovision would refuse to act, or vice versa.
 */
export const deprovisionableBucketSql = (memberAlias: string, channelAlias: string): string => `
  ${channelAlias}.discord_channel_id IS NOT NULL
  AND NOT (${channelAlias}.bucket = ANY (${desiredBucketsSql(memberAlias)}))
  AND NOT ${missingDesiredBucketSql(memberAlias, `${channelAlias}.team_id`, `${channelAlias}.team_member_id`)}`;
