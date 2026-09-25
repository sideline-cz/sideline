// The `ancestors` walk inside `findScopedTrainingTypeIds` is a LATERAL recursive walk UP
// `groups.parent_id`, one per `group_members` row. It had no depth bound, so a cycle made it
// run forever — and it backs `getScopedTrainingTypeIds` → `api/scoping.ts`'s
// `checkCoachScoping`, i.e. a permission gate on event create/edit. Unbounded, one corrupt row
// would hang event creation for anyone whose group sat in the cycle.
//
// `SET LOCAL statement_timeout` bounds the blast radius, so an unguarded query fails this
// assertion rather than wedging the (serial) integration suite.
//
// NOTE: this walk also has no `is_archived` filter, and that is deliberately left alone — see
// the comment at the query. Adding it would shrink a coach's allowed-set, and `checkCoachScoping`
// reads an EMPTY set as "allow everything", so tightening the query would LOOSEN the permission.
import { describe, expect, it } from '@effect/vitest';
import type { GroupModel, Team } from '@sideline/domain';
import { Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  GroupsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => Effect.runPromise(cleanDatabase.pipe(Effect.provide(TestPgClient))));

const wireParentDirectly = (groupId: GroupModel.GroupId, parentId: GroupModel.GroupId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) => sql`UPDATE groups SET parent_id = ${parentId} WHERE id = ${groupId}`),
  );

/** role_groups + role_training_types rows for the cyclic group.
 *
 * These are NOT decoration. The recursive walk is a LATERAL joined to `role_groups` and
 * `role_training_types`; with those tables empty the planner never executes it at all, and the
 * test passes whether or not the depth bound exists. (It did, the first time this was written.)
 */
const scopeRoleToGroup = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        WITH r AS (
          INSERT INTO roles (team_id, name, is_built_in) VALUES (${teamId}, 'Cycle coach', false)
          RETURNING id
        ), tt AS (
          INSERT INTO training_types (team_id, name) VALUES (${teamId}, 'Cycle type')
          RETURNING id
        ), rg AS (
          INSERT INTO role_groups (role_id, group_id) SELECT r.id, ${groupId} FROM r
        )
        INSERT INTO role_training_types (role_id, training_type_id)
        SELECT r.id, tt.id FROM r, tt
      `,
    ),
  );

describe('EventsRepository — findScopedTrainingTypeIds ancestor-walk cycle bound', () => {
  it.effect(
    'terminates instead of hanging when the member sits in a group that is part of a parent_id cycle',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('scoped-cycle-user')),
        Effect.bind('team', ({ user }) => createTeam(nextDiscordId(), user.id)),
        Effect.bind('member', ({ team, user }) => createTeamMember(team.id, user.id)),
        Effect.bind('groupA', ({ team }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertGroup(
                team.id,
                'Scoped cycle A',
                Option.none(),
                Option.none(),
                Option.none(),
              ),
            ),
          ),
        ),
        Effect.bind('groupB', ({ team, groupA }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insertGroup(
                team.id,
                'Scoped cycle B',
                Option.some(groupA.id),
                Option.none(),
                Option.none(),
              ),
            ),
          ),
        ),
        // B.parent_id is already A; wiring A.parent_id -> B closes the loop A -> B -> A.
        Effect.tap(({ groupA, groupB }) => wireParentDirectly(groupA.id, groupB.id)),
        Effect.tap(({ groupB, member }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.addMemberById(groupB.id, member.id)),
          ),
        ),
        // Without these rows the LATERAL is never executed and the guard is untested.
        Effect.tap(({ team, groupB }) => scopeRoleToGroup(team.id, groupB.id)),
        Effect.bind('outcome', ({ member }) =>
          Effect.Do.pipe(
            Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
            Effect.bind('repo', () => EventsRepository.asEffect()),
            Effect.flatMap(({ sql, repo }) =>
              sql
                .withTransaction(
                  Effect.Do.pipe(
                    Effect.tap(() => sql`SET LOCAL statement_timeout = '1500'`),
                    Effect.flatMap(() => repo.getScopedTrainingTypeIds(member.id)),
                  ),
                )
                .pipe(Effect.exit),
            ),
          ),
        ),
        Effect.tap(({ outcome }) =>
          Effect.sync(() => {
            // Without the bound the CTE never terminates, Postgres kills it via
            // statement_timeout, and catchSqlErrors surfaces that as a defect.
            expect(Exit.isSuccess(outcome)).toBe(true);
            if (Exit.isSuccess(outcome)) {
              // The scoped role yields exactly one training type; the point is that the
              // walk TERMINATED to produce it.
              expect(outcome.value.length).toBe(1);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
    8000,
  );
});
