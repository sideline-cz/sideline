import { Auth, EventApi, EventSeriesApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, DateTime, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { checkCoachScoping, checkGroupAccess, checkTrainingTypeOwnerGroup } from '~/api/scoping.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { computeHorizonEnd, generateOccurrenceDates } from '~/services/RecurrenceService.js';
import { emitTrainingClaimRequestIfApplicable } from '~/services/TrainingClaimEmitter.js';
import {
  assertDialectMatches,
  resolveSeriesOccurrenceInstant,
  seriesSqlZone,
} from '~/utils/seriesTimeDialect.js';

const forbidden = new EventApi.Forbidden();
const notFound = new EventSeriesApi.EventSeriesNotFound();
const notActive = new EventSeriesApi.EventSeriesNotActive();

export const EventSeriesApiLive = HttpApiBuilder.group(Api, 'eventSeries', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('series', () => EventSeriesRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.map(({ members, events, series, teamSettings, trainingTypes, groups }) =>
      handlers
        .handle('createEventSeries', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'event:create', forbidden),
            ),
            Effect.bind('teamZone', () =>
              teamSettings.findByTeamId(teamId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => 'Europe/Prague',
                    onSome: (s) => s.timezone,
                  }),
                ),
              ),
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.tap(({ membership, isAdmin }) =>
              checkCoachScoping(events, membership.id, payload.trainingTypeId, isAdmin, forbidden),
            ),
            Effect.tap(({ membership, isAdmin }) =>
              checkTrainingTypeOwnerGroup(
                trainingTypes,
                groups,
                membership.id,
                payload.trainingTypeId,
                isAdmin,
                forbidden,
                teamId,
              ),
            ),
            // Inherit groups from training type if not provided
            Effect.bind('resolvedGroups', () => {
              const hasOwner = Option.isSome(payload.ownerGroupId);
              const hasMember = Option.isSome(payload.memberGroupId);
              if (hasOwner || hasMember || Option.isNone(payload.trainingTypeId)) {
                return Effect.succeed({
                  ownerGroupId: payload.ownerGroupId,
                  memberGroupId: payload.memberGroupId,
                });
              }
              return trainingTypes.findTrainingTypeById(payload.trainingTypeId.value).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => ({
                      ownerGroupId: payload.ownerGroupId,
                      memberGroupId: payload.memberGroupId,
                    }),
                    onSome: (tt) => ({
                      ownerGroupId: tt.owner_group_id,
                      memberGroupId: tt.member_group_id,
                    }),
                  }),
                ),
              );
            }),
            Effect.bind('inserted', ({ membership, resolvedGroups }) =>
              series.insertEventSeries({
                teamId,
                trainingTypeId: payload.trainingTypeId,
                title: payload.title,
                description: payload.description,
                frequency: payload.frequency,
                daysOfWeek: payload.daysOfWeek,
                startDate: payload.startDate,
                endDate: payload.endDate,
                startTime: payload.startTime,
                endTime: payload.endTime,
                location: payload.location,
                locationUrl: payload.locationUrl,
                createdBy: membership.id,
                ownerGroupId: resolvedGroups.ownerGroupId,
                memberGroupId: resolvedGroups.memberGroupId,
                // Create has no existing row to assert a dialect against, so the payload's
                // declared dialect BECOMES the new row's dialect — written explicitly rather
                // than left to the column's `DEFAULT FALSE`. See `insertEventSeries`'s doc
                // comment in `EventSeriesRepository.ts` for why this must not fall back to the
                // default. (Update, by contrast, does assert — see `assertDialectMatches` in
                // `updateEventSeries` below.)
                timesAreTeamLocal: payload.timesAreTeamLocal,
              }),
            ),
            Effect.bind('horizonDays', () => teamSettings.getHorizonDays(teamId)),
            Effect.let('effectiveEnd', ({ inserted, horizonDays }) =>
              computeHorizonEnd({
                seriesEndDate: Option.getOrNull(inserted.end_date),
                horizonDays,
              }),
            ),
            Effect.let('dates', ({ inserted, effectiveEnd }) =>
              generateOccurrenceDates({
                frequency: inserted.frequency,
                daysOfWeek: inserted.days_of_week,
                startDate: inserted.start_date,
                endDate: effectiveEnd,
              }),
            ),
            Effect.tap(({ inserted, dates, membership, teamZone }) =>
              Effect.all(
                Array.map(dates, (date) => {
                  const dateStr = DateTime.formatIsoDateUtc(date);
                  // `inserted.times_are_team_local` is read back from the `RETURNING` clause,
                  // not assumed from the DB default — the site that stays correct unchanged
                  // once that default flips at Release N+1.
                  const startAt = resolveSeriesOccurrenceInstant(
                    dateStr,
                    inserted.start_time,
                    teamZone,
                    inserted.times_are_team_local,
                  );
                  const endAt = Option.map(inserted.end_time, (t) =>
                    resolveSeriesOccurrenceInstant(
                      dateStr,
                      t,
                      teamZone,
                      inserted.times_are_team_local,
                    ),
                  );
                  return events
                    .insertEvent({
                      teamId,
                      trainingTypeId: inserted.training_type_id,
                      eventType: 'training',
                      title: inserted.title,
                      description: inserted.description,
                      startAt,
                      endAt,
                      location: inserted.location,
                      locationUrl: inserted.location_url,
                      createdBy: membership.id,
                      seriesId: Option.some(inserted.id),
                      ownerGroupId: inserted.owner_group_id,
                      memberGroupId: inserted.member_group_id,
                    })
                    .pipe(
                      Effect.tap((event) =>
                        emitTrainingClaimRequestIfApplicable({
                          teamId,
                          eventId: event.id,
                          eventType: event.event_type,
                          ownerGroupId: event.owner_group_id,
                          title: event.title,
                          description: event.description,
                          startAt: event.start_at,
                          endAt: event.end_at,
                          location: event.location,
                          locationUrl: event.location_url,
                          allDay: event.all_day,
                        }),
                      ),
                      Effect.tap((event) =>
                        events.markEventPersonalMessagesDirty(event.id).pipe(Effect.ignore),
                      ),
                    );
                }),

                { concurrency: 1 },
              ),
            ),
            Effect.tap(({ inserted, effectiveEnd }) =>
              series.updateLastGeneratedDate(inserted.id, effectiveEnd),
            ),
            Effect.map(
              ({ inserted, teamZone }) =>
                new EventSeriesApi.EventSeriesInfo({
                  seriesId: inserted.id,
                  teamId: inserted.team_id,
                  title: inserted.title,
                  frequency: inserted.frequency,
                  daysOfWeek: inserted.days_of_week,
                  startDate: inserted.start_date,
                  endDate: inserted.end_date,
                  status: inserted.status,
                  trainingTypeId: inserted.training_type_id,
                  trainingTypeName: Option.none(),
                  startTime: inserted.start_time,
                  endTime: inserted.end_time,
                  location: inserted.location,
                  locationUrl: inserted.location_url,
                  ownerGroupId: inserted.owner_group_id,
                  ownerGroupName: Option.none(),
                  memberGroupId: inserted.member_group_id,
                  memberGroupName: Option.none(),
                  timezone: Option.some(teamZone),
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed creating event series — no row returned'),
            ),
          ),
        )
        .handle('listEventSeries', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.tap(({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('teamZone', () =>
              teamSettings.findByTeamId(teamId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => 'Europe/Prague',
                    onSome: (s) => s.timezone,
                  }),
                ),
              ),
            ),
            Effect.bind('list', () => series.findSeriesByTeamId(teamId)),
            Effect.map(({ list, teamZone }) =>
              Array.map(
                list,
                (s) =>
                  new EventSeriesApi.EventSeriesInfo({
                    seriesId: s.id,
                    teamId: s.team_id,
                    title: s.title,
                    frequency: s.frequency,
                    daysOfWeek: s.days_of_week,
                    startDate: s.start_date,
                    endDate: s.end_date,
                    status: s.status,
                    trainingTypeId: s.training_type_id,
                    trainingTypeName: s.training_type_name,
                    startTime: s.start_time,
                    endTime: s.end_time,
                    location: s.location,
                    locationUrl: s.location_url,
                    ownerGroupId: s.owner_group_id,
                    ownerGroupName: s.owner_group_name,
                    memberGroupId: s.member_group_id,
                    memberGroupName: s.member_group_name,
                    timezone: Option.some(teamZone),
                  }),
              ),
            ),
          ),
        )
        .handle('getEventSeries', ({ params: { teamId, seriesId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.let('canEdit', ({ membership }) => hasPermission(membership, 'event:edit')),
            Effect.let('canCancel', ({ membership }) => hasPermission(membership, 'event:cancel')),
            Effect.bind('teamZone', () =>
              teamSettings.findByTeamId(teamId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => 'Europe/Prague',
                    onSome: (s) => s.timezone,
                  }),
                ),
              ),
            ),
            Effect.bind('found', () =>
              series.findSeriesById(seriesId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ found }) =>
              found.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.map(
              ({ found, canEdit, canCancel, teamZone }) =>
                new EventSeriesApi.EventSeriesDetail({
                  seriesId: found.id,
                  teamId: found.team_id,
                  title: found.title,
                  description: found.description,
                  frequency: found.frequency,
                  daysOfWeek: found.days_of_week,
                  startDate: found.start_date,
                  endDate: found.end_date,
                  status: found.status,
                  trainingTypeId: found.training_type_id,
                  trainingTypeName: found.training_type_name,
                  startTime: found.start_time,
                  endTime: found.end_time,
                  location: found.location,
                  locationUrl: found.location_url,
                  ownerGroupId: found.owner_group_id,
                  ownerGroupName: found.owner_group_name,
                  memberGroupId: found.member_group_id,
                  memberGroupName: found.member_group_name,
                  canEdit: canEdit && found.status === 'active',
                  canCancel: canCancel && found.status === 'active',
                  timezone: Option.some(teamZone),
                }),
            ),
          ),
        )
        .handle('updateEventSeries', ({ params: { teamId, seriesId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'event:edit', forbidden)),
            Effect.bind('teamZone', () =>
              teamSettings.findByTeamId(teamId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => 'Europe/Prague',
                    onSome: (s) => s.timezone,
                  }),
                ),
              ),
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.bind('existing', () =>
              series.findSeriesById(seriesId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            // TWO checks in ONE pipe step, sequenced with `Effect.andThen`: this handler
            // already uses all 20 of `pipe`'s typed overload slots, so they cannot each have
            // their own `Effect.tap`. The `andThen` (rather than a nested ternary) is what keeps
            // the precedence legible: the status check short-circuits first, so a caller who is
            // BOTH editing a non-active series AND declaring the wrong dialect gets
            // `EventSeriesNotActive`, not `EventSeriesTimeDialectMismatch`. Do not reorder them.
            // Note that both errors are HTTP 400, so a status-code-only test cannot tell the two
            // apart — the ordering has to be read off this code.
            //
            // Check 2 (Release N, §N.3) rejects a payload whose declared time dialect disagrees
            // with the dialect the row is actually stored in, rather than silently translating
            // between the two. Both checks sit BEFORE the `checkGroupAccess`/`checkCoachScoping`/
            // `checkTrainingTypeOwnerGroup` permission checks below because they are pure,
            // side-effect-free structural validations of the request itself (same class as the
            // `locationUrl`-requires-`location` check further down), independent of who is making
            // it. There is no create-side counterpart to check 2: create has no existing row to
            // assert against, so its payload's dialect simply becomes the new row's.
            //
            // Check 2 applies ONLY when the payload actually supplies a time, and that gate is
            // evaluated here, BEFORE `resolved.startTime`/`resolved.endTime` below fall back to
            // `existing.start_time`/`existing.end_time` for an omitted field. A location-only
            // PATCH asserts no dialect for a value it never sent and must pass through untouched,
            // even though `timesAreTeamLocal` always encodes on the wire (it is not
            // `Option`-wrapped — see `EventSeriesApi.ts`).
            //
            // `payload.endTime` is `Option<Option<string>>`, so the gate is
            // `Option.exists(payload.endTime, Option.isSome)` and not `Option.isSome`: the outer
            // `Some` covers both "set a new end time" and "clear the end time to `null`"
            // (`Some(None)`), and a clear supplies no time-of-day to declare a dialect for.
            Effect.tap(({ existing }) =>
              Effect.andThen(
                existing.status !== 'active' ? Effect.fail(notActive) : Effect.void,
                () =>
                  Option.isSome(payload.startTime) || Option.exists(payload.endTime, Option.isSome)
                    ? assertDialectMatches(payload.timesAreTeamLocal, existing.times_are_team_local)
                    : Effect.void,
              ),
            ),
            // Check owner group access
            Effect.tap(({ existing, membership, isAdmin }) =>
              isAdmin
                ? Effect.void
                : checkGroupAccess(groups, membership.id, existing.owner_group_id).pipe(
                    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(forbidden))),
                  ),
            ),
            Effect.tap(({ existing, isAdmin, membership }) =>
              checkCoachScoping(
                events,
                membership.id,
                Option.match(payload.trainingTypeId, {
                  onNone: () => existing.training_type_id,
                  onSome: (v) => v,
                }),
                isAdmin,
                forbidden,
              ),
            ),
            Effect.tap(({ existing, isAdmin, membership }) =>
              checkTrainingTypeOwnerGroup(
                trainingTypes,
                groups,
                membership.id,
                Option.match(payload.trainingTypeId, {
                  onNone: () => existing.training_type_id,
                  onSome: (v) => v,
                }),
                isAdmin,
                forbidden,
                teamId,
              ),
            ),
            Effect.let('resolved', ({ existing }) => ({
              title: Option.getOrElse(payload.title, () => existing.title),
              trainingTypeId: Option.match(payload.trainingTypeId, {
                onNone: () => existing.training_type_id,
                onSome: (v) => v,
              }),
              description: Option.match(payload.description, {
                onNone: () => existing.description,
                onSome: (v) => v,
              }),
              daysOfWeek: Option.getOrElse(payload.daysOfWeek, () => existing.days_of_week),
              startTime: Option.getOrElse(payload.startTime, () => existing.start_time),
              endTime: Option.match(payload.endTime, {
                onNone: () => existing.end_time,
                onSome: (v) => v,
              }),
              location: Option.match(payload.location, {
                onNone: () => existing.location,
                onSome: (v) => v,
              }),
              locationUrl: Option.match(payload.locationUrl, {
                onNone: () => existing.location_url,
                onSome: (v) => v,
              }),
              endDate: Option.match(payload.endDate, {
                onNone: () => existing.end_date,
                onSome: (v) => v,
              }),
              ownerGroupId: Option.match(payload.ownerGroupId, {
                onNone: () => existing.owner_group_id,
                onSome: (v) => v,
              }),
              memberGroupId: Option.match(payload.memberGroupId, {
                onNone: () => existing.member_group_id,
                onSome: (v) => v,
              }),
            })),
            Effect.tap(({ resolved }) =>
              Option.isSome(resolved.locationUrl) && Option.isNone(resolved.location)
                ? Effect.fail(forbidden)
                : Effect.void,
            ),
            Effect.tap(({ resolved }) =>
              series.updateEventSeries({
                id: seriesId,
                title: resolved.title,
                trainingTypeId: resolved.trainingTypeId,
                description: resolved.description,
                daysOfWeek: resolved.daysOfWeek,
                startTime: resolved.startTime,
                endTime: resolved.endTime,
                location: resolved.location,
                locationUrl: resolved.locationUrl,
                endDate: resolved.endDate,
                ownerGroupId: resolved.ownerGroupId,
                memberGroupId: resolved.memberGroupId,
              }),
            ),
            Effect.tap(({ existing, resolved, teamZone }) =>
              events.updateFutureUnmodifiedInSeries(seriesId, new Date(), {
                title: resolved.title,
                trainingTypeId: resolved.trainingTypeId,
                description: resolved.description,
                startTime: resolved.startTime,
                endTime: resolved.endTime,
                location: resolved.location,
                locationUrl: resolved.locationUrl,
                // Release N (§N.2 item 4): a FALSE (UTC-dialect) series' materialized
                // occurrences must be re-derived in UTC, not the team zone — `seriesSqlZone`
                // yields `'UTC'` for that case, and the team's own zone for a TRUE one. With
                // `tz = 'UTC'`, `EventsRepository.updateFutureUnmodified`'s
                // `((start_at AT TIME ZONE ${tz})::date + ${time}::time) AT TIME ZONE ${tz}` is
                // *semantically* (not character-) identical to the pre-#650 SQL.
                //
                // Note `EventsRepository.ts`'s corresponding `WHERE (start_at AT TIME ZONE
                // 'UTC')::date >= …` predicate still hardcodes `'UTC'` — #650 converted the
                // `SET` clause and not the predicate. The two agree whenever `tz` resolves to
                // `'UTC'`, i.e. for every FALSE row; that pre-existing #650 mismatch only
                // matters for a TRUE-dialect series, which this release can only produce via an
                // explicit `timesAreTeamLocal: true` create. Out of scope here.
                timezone: seriesSqlZone(teamZone, existing.times_are_team_local),
              }),
            ),
            Effect.tap(() =>
              events
                .markSeriesFuturePersonalMessagesDirty(seriesId, new Date())
                .pipe(Effect.ignore),
            ),
            Effect.tap(({ existing, resolved, membership, teamZone }) =>
              teamSettings.getHorizonDays(teamId).pipe(
                Effect.flatMap((horizonDays) => {
                  const effectiveEnd = computeHorizonEnd({
                    seriesEndDate: Option.getOrNull(resolved.endDate),
                    horizonDays,
                  });
                  return Option.match(existing.last_generated_date, {
                    onNone: () => Effect.void,
                    onSome: (lastGen) => {
                      if (!DateTime.isGreaterThan(effectiveEnd, lastGen)) return Effect.void;
                      const nextDay = DateTime.add(lastGen, { days: 1 });
                      const newDates = generateOccurrenceDates({
                        frequency: existing.frequency,
                        daysOfWeek: existing.days_of_week,
                        startDate: nextDay,
                        endDate: effectiveEnd,
                      });
                      if (newDates.length === 0) return Effect.void;
                      return Effect.all(
                        Array.map(newDates, (date) => {
                          const dateStr = DateTime.formatIsoDateUtc(date);
                          // Deliberately pairs `existing.times_are_team_local` with the
                          // already-stale `existing.start_time` this site reads (a
                          // pre-existing #650 bug, out of scope here: `existing` is captured
                          // before `series.updateEventSeries` above may have changed
                          // `start_time`). Don't "fix" one without the other — both are
                          // photographs of the row from before this request's own update.
                          const startAt = resolveSeriesOccurrenceInstant(
                            dateStr,
                            existing.start_time,
                            teamZone,
                            existing.times_are_team_local,
                          );
                          const endAt = Option.map(existing.end_time, (t) =>
                            resolveSeriesOccurrenceInstant(
                              dateStr,
                              t,
                              teamZone,
                              existing.times_are_team_local,
                            ),
                          );
                          return events
                            .insertEvent({
                              teamId,
                              trainingTypeId: existing.training_type_id,
                              eventType: 'training',
                              title: existing.title,
                              description: existing.description,
                              startAt,
                              endAt,
                              location: existing.location,
                              locationUrl: existing.location_url,
                              createdBy: membership.id,
                              seriesId: Option.some(existing.id),
                              ownerGroupId: existing.owner_group_id,
                              memberGroupId: existing.member_group_id,
                            })
                            .pipe(
                              Effect.tap((event) =>
                                events.markEventPersonalMessagesDirty(event.id).pipe(Effect.ignore),
                              ),
                            );
                        }),
                        { concurrency: 1 },
                      ).pipe(
                        Effect.tap(() => series.updateLastGeneratedDate(existing.id, effectiveEnd)),
                      );
                    },
                  });
                }),
              ),
            ),
            Effect.bind('detail', () =>
              series.findSeriesById(seriesId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.map(
              ({ detail, membership, teamZone }) =>
                new EventSeriesApi.EventSeriesDetail({
                  seriesId: detail.id,
                  teamId: detail.team_id,
                  title: detail.title,
                  description: detail.description,
                  frequency: detail.frequency,
                  daysOfWeek: detail.days_of_week,
                  startDate: detail.start_date,
                  endDate: detail.end_date,
                  status: detail.status,
                  trainingTypeId: detail.training_type_id,
                  trainingTypeName: detail.training_type_name,
                  startTime: detail.start_time,
                  endTime: detail.end_time,
                  location: detail.location,
                  locationUrl: detail.location_url,
                  ownerGroupId: detail.owner_group_id,
                  ownerGroupName: detail.owner_group_name,
                  memberGroupId: detail.member_group_id,
                  memberGroupName: detail.member_group_name,
                  canEdit: hasPermission(membership, 'event:edit') && detail.status === 'active',
                  canCancel:
                    hasPermission(membership, 'event:cancel') && detail.status === 'active',
                  timezone: Option.some(teamZone),
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed updating event series — no row returned'),
            ),
          ),
        )
        .handle('cancelEventSeries', ({ params: { teamId, seriesId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'event:cancel', forbidden),
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.bind('existing', () =>
              series.findSeriesById(seriesId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.tap(({ existing }) =>
              existing.status !== 'active' ? Effect.fail(notActive) : Effect.void,
            ),
            // Check owner group access
            Effect.tap(({ existing, membership, isAdmin }) =>
              isAdmin
                ? Effect.void
                : checkGroupAccess(groups, membership.id, existing.owner_group_id).pipe(
                    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(forbidden))),
                  ),
            ),
            Effect.tap(({ existing, isAdmin, membership }) =>
              checkCoachScoping(
                events,
                membership.id,
                existing.training_type_id,
                isAdmin,
                forbidden,
              ),
            ),
            Effect.tap(() => series.cancelEventSeries(seriesId)),
            Effect.tap(() => events.cancelFutureInSeries(seriesId, new Date())),
            Effect.tap(() =>
              events
                .markSeriesFuturePersonalMessagesDirty(seriesId, new Date())
                .pipe(Effect.ignore),
            ),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
