/**
 * Shared SQL fragment for "which roles does this team member EFFECTIVELY hold" (the
 * fix/role-linking plan). A member's effective roles are `member_roles` (direct
 * assignment) UNION the roles reachable through `group_members` → a recursive walk UP
 * `groups.parent_id` (the member's group and all its ancestors) → `role_groups`. Six+
 * call sites need this exact rule and previously reimplemented it ad hoc (three
 * correctly, three — `findRosterByTeamQuery`, `findRosterMemberQuery`,
 * `RostersRepository.findMemberEntries.role_names` — only ever looked at the direct
 * half), which is how the "group roles are invisible on the roster" bug shipped.
 * Centralising it here, spliced with `sql.unsafe(...)`, is the same approach already
 * established in this repo at `applications/server/src/repositories/eventVisibility.ts`
 * (see its header) and used from `EventsRepository.ts` / `TeamSettingsRepository.ts`.
 *
 * `effectiveRolesFrom(tm)` takes only an IDENTIFIER chosen in source — the alias of a
 * `team_members` row already in scope in the enclosing query (e.g. `'tm'`) — never a
 * user-supplied value, so there is no injection surface. It expands to a derived table
 * yielding one row per role the member `${tm}` effectively holds:
 *   (role_id, name, is_built_in, team_id, source, group_names)
 * where `source` is `'direct'` (only a `member_roles` row), `'inherited'` (only reached
 * via a group) or `'both'` (both at once — removing the direct grant alone would NOT
 * revoke the role), and `group_names` lists the group(s) granting it (empty for
 * `'direct'`). The row source already dedupes to one row per `role_id` (`GROUP BY`), so
 * aggregates built on top of it never need their own `DISTINCT role_id` handling.
 *
 * Three decisions baked into this fragment, all deliberate:
 *
 * 1. **Archiving a group severs the chain, exactly like every other recursive group
 *    query in `GroupsRepository.ts`** (e.g. `countMembersForGroup`,
 *    `findDescendantMembersWithDiscordIdQuery`): the `is_archived` check lives in the
 *    RECURSIVE TERM itself (`WHERE anc_g.parent_id IS NOT NULL AND anc_g.is_archived =
 *    false AND anc_g.team_id = ${tm}.team_id AND a.depth < 32`), not only on the final
 *    join. An archived ancestor stops the walk from reaching anything further up the
 *    chain — its own further ancestors are simply never added to `anc` — the same way
 *    an archived descendant blocks `findDescendantMembersWithDiscordIdQuery` from
 *    reaching anything below it. The final join (`groups g ON g.id = anc.id AND
 *    g.is_archived = false AND g.team_id = ${tm}.team_id`) additionally excludes the
 *    archived node's OWN `role_groups` grant (it's still present in `anc` — the
 *    recursive filter only gates walking PAST it, not whether it's included itself).
 *    `deleteGroup` only sets `is_archived` (it never deletes `group_members` /
 *    `role_groups`), so without either filter an "archived" group (or one of its
 *    ancestors) would keep granting.
 * 2. **Archiving a ROLE revokes it everywhere, via `AND r.is_archived = false` on BOTH
 *    `JOIN roles r` clauses (direct and group-inherited).** `deleteRole` (`api/role.ts`)
 *    only calls `RolesRepository.archiveRoleById` — `UPDATE roles SET is_archived =
 *    true`, never a delete of `member_roles` / `role_groups` / `role_permissions` — so
 *    without this filter an archived role kept granting its permissions to everyone
 *    holding it. `deleteRole`'s `RoleInUse` guard (`getMemberCountForRole > 0`, backed by
 *    `RolesRepository.countMembersForRole`, which splices THIS fragment and so already
 *    counts group-inherited holders) only makes that state rare, not impossible — it is a
 *    point-in-time count, and `archiveRoleById` deletes no `role_groups` row: a role
 *    attached to a group that is EMPTY at delete time passes the guard and starts
 *    granting again the moment someone joins that group. Rows predating the guard's own
 *    group-inheritance fix, a holder reachable only through an archived group (excluded
 *    from the count by construction), and an `assignRole` landing between the guard's
 *    read and the archive (`deleteRole` spans the two with no transaction) reach it too.
 *    The filter belongs HERE, on the one fragment every "which roles/permissions does
 *    this member hold?" query splices, rather than as a
 *    `JOIN roles ... AND r.is_archived = false` bolted onto
 *    individual callers — `TeamMembersRepository.findEffectiveRolesForMembersQuery`
 *    carried exactly such a bolt-on, making it the only EFFECTIVE-ROLES query that
 *    revoked an archived role, so it disagreed with its own per-member sibling
 *    `findEffectiveRoleIdsForMemberQuery` (see `syncGroupRoleMembers.ts`'s header).
 * 3. **Cycle guard.** `groups.parent_id` has no DB-level acyclicity constraint, so the
 *    recursive walk carries a `depth` column and stops at `depth < 32` — a corrupted or
 *    maliciously-edited parent chain terminates the query instead of looping forever.
 *
 * Do NOT change `ORDER BY name` in `effectiveRoleNamesAgg` to anything else (e.g. the
 * tempting `is_built_in DESC, name`) — Postgres requires a `string_agg(DISTINCT x, sep
 * ORDER BY y)` call's `ORDER BY` expression to be a member of the `DISTINCT` argument
 * list, so ordering by anything other than `name` there is a syntax error, not just a
 * style choice. Where a derived aggregate's own `ORDER BY`/`DISTINCT` argument sets
 * could diverge (they don't for the aggregates below), prefer aggregating over a
 * `SELECT DISTINCT` subquery instead of trying to satisfy the rule inline.
 */

/**
 * The row source itself: one row per role `${tm}` effectively holds, deduped, with
 * provenance. `${tm}` MUST already be a `team_members` row in scope (e.g. the outer
 * query's `tm` alias) — this expands to a parenthesised derived table, so callers use
 * it directly after `FROM`/`JOIN`, e.g. `FROM ${sql.unsafe(effectiveRolesFrom('tm'))} er`.
 */
export const effectiveRolesFrom = (tm: string): string => `
  (
    SELECT
      combined.role_id,
      combined.name,
      combined.is_built_in,
      combined.is_default,
      combined.team_id,
      CASE
        WHEN bool_or(combined.via_direct) AND bool_or(combined.via_group) THEN 'both'
        WHEN bool_or(combined.via_direct) THEN 'direct'
        ELSE 'inherited'
      END AS source,
      COALESCE(
        array_agg(DISTINCT combined.group_name) FILTER (WHERE combined.group_name IS NOT NULL),
        ARRAY[]::text[]
      ) AS group_names
    FROM (
      SELECT r.id AS role_id, r.name, r.is_built_in, r.is_default, r.team_id,
             true AS via_direct, false AS via_group, NULL::text AS group_name
      FROM member_roles mr
      JOIN roles r ON r.id = mr.role_id AND r.is_archived = false
      WHERE mr.team_member_id = ${tm}.id
      UNION ALL
      SELECT r.id AS role_id, r.name, r.is_built_in, r.is_default, r.team_id,
             false AS via_direct, true AS via_group, g.name AS group_name
      FROM group_members gm
      JOIN LATERAL (
        WITH RECURSIVE ancestors AS (
          SELECT gm.group_id AS id, 0 AS depth
          UNION ALL
          SELECT anc_g.parent_id, a.depth + 1
          FROM groups anc_g
          JOIN ancestors a ON anc_g.id = a.id
          WHERE anc_g.parent_id IS NOT NULL
            AND anc_g.is_archived = false
            AND anc_g.team_id = ${tm}.team_id
            AND a.depth < 32
        )
        SELECT id FROM ancestors
      ) anc ON true
      JOIN groups g ON g.id = anc.id AND g.is_archived = false AND g.team_id = ${tm}.team_id
      JOIN role_groups rg ON rg.group_id = g.id
      JOIN roles r ON r.id = rg.role_id AND r.is_archived = false
      WHERE gm.team_member_id = ${tm}.id
    ) combined
    GROUP BY combined.role_id, combined.name, combined.is_built_in, combined.is_default, combined.team_id
  )
`;

/**
 * "Does this member hold the role a NEW member would be given?" — the membership form of the
 * same rule `TeamMembersRepository.getDefaultRoleId` uses to PICK one role on join.
 *
 * The two must never drift: if they do, a team that sets a custom default (Poletime's `Guest`)
 * hands new members a role the RSVP-reminder and missed-RSVP queries do not recognise, and those
 * members silently stop receiving reminders. `is_default` is the configured default; the
 * built-in `Player` half is the same fallback the resolver carries, so a team with no configured
 * default keeps exactly today's population.
 *
 * Deliberately a UNION, not a priority pick (which is what the resolver does): a legacy member
 * still holding `Player` keeps receiving reminders after the team switches its default to
 * `Guest`. Dropping them would be a second, quieter bug.
 *
 * ponytail: the legacy half of this UNION is hardcoded to `Player` — it is NOT "whatever the
 * previous default was". That only covers a team's FIRST default change. A SECOND change (e.g.
 * Poletime later adds `Member` and switches the default from `Guest` to it) stops covering the
 * cohort that joined during the `Guest` era: they hold only `Guest`, `eff.is_default` is now
 * `false` for `Guest` rows, and they were never `Player`, so they silently drop out of
 * `findNonRespondersByEventId` and stop accruing `missed_rsvps`. Known ceiling, not fixed here.
 * Upgrade path: either a persistent `roles.is_rsvp_eligible` column set on every role that has
 * ever been the default (never cleared on a later change), or retaining the full history of past
 * defaults instead of collapsing to one `is_default` boolean.
 *
 * `${eff}` is an alias chosen in source (the `eff` alias over `effectiveRolesFrom`, or the `r`
 * alias in the resolver) — never a user value, no injection surface.
 */
export const holdsDefaultRoleWhere = (eff: string): string =>
  `(${eff}.is_default OR (${eff}.name = 'Player' AND ${eff}.is_built_in = true))`;

/**
 * The three aggregates below are each defined ONCE, parameterised by the SQL of the row
 * source they aggregate over (`src` — either an inline `effectiveRolesFrom(tm)` derived
 * table for the standalone scalar-subquery form, or the name of the materialized CTE
 * inside `effectiveRolesAggLateral`). They are internal: callers use the exported
 * `effectiveRoleNamesAgg` / `effectivePermissionsAgg` / `effectiveRolesAggLateral`
 * wrappers below. Keeping one definition per aggregate is what stops the lateral form
 * and the scalar form from silently drifting apart (e.g. one gaining a `DISTINCT` or an
 * `ORDER BY` the other lacks) — they are the SAME expression, just pointed at a
 * different row source.
 */

/**
 * `role_names` — comma-joined, alphabetically ordered, empty string (not `NULL`) when
 * `${tm}` holds no effective roles.
 */
const roleNamesExpr = (src: string): string => `
  COALESCE(
    (SELECT string_agg(DISTINCT er.name, ',' ORDER BY er.name) FROM ${src} er),
    ''
  )
`;

/**
 * `permissions` — comma-joined, deduped (two different effective roles can grant the
 * same permission), empty string when none. No ordering requirement, so no
 * `DISTINCT`/`ORDER BY` conflict to worry about.
 */
const permissionsExpr = (src: string): string => `
  COALESCE(
    (SELECT string_agg(DISTINCT rp.permission, ',')
     FROM ${src} er
     JOIN role_permissions rp ON rp.role_id = er.role_id),
    ''
  )
`;

/**
 * `effective_roles` — full per-role provenance as a JSON array, `[{role_id, name,
 * is_built_in, source, group_names}, ...]`, ordered by name, `[]` (not `NULL`) when
 * `${tm}` holds no effective roles. Feeds `RosterEntry.effective_roles` →
 * `Roster.RosterPlayer.effectiveRoles`. node-pg parses `jsonb` columns into plain JS
 * values automatically (see `DashboardLayoutsRepository.ts`'s header comment for the
 * established precedent), so the read side decodes this with a plain `Schema.Array(...)`
 * — no JSON string parsing.
 */
const rolesJsonExpr = (src: string): string => `
  COALESCE(
    (SELECT jsonb_agg(
       jsonb_build_object(
         'role_id', er.role_id,
         'name', er.name,
         'is_built_in', er.is_built_in,
         'source', er.source,
         'group_names', er.group_names
       ) ORDER BY er.name
     )
     FROM ${src} er),
    '[]'::jsonb
  )
`;

/**
 * Standalone `role_names` scalar subquery. Drop-in replacement for every ad hoc
 * `role_names` subquery this fragment supersedes; behaviour-neutral everywhere it
 * already unioned the group half, and the fix everywhere it didn't. Prefer
 * `effectiveRolesAggLateral` when the same query also needs `permissions` and/or
 * `effective_roles` for the same `${tm}` row.
 */
export const effectiveRoleNamesAgg = (tm: string): string => roleNamesExpr(effectiveRolesFrom(tm));

/**
 * Standalone `permissions` scalar subquery. See `effectiveRoleNamesAgg`.
 */
export const effectivePermissionsAgg = (tm: string): string =>
  permissionsExpr(effectiveRolesFrom(tm));

/**
 * `LEFT JOIN LATERAL (...) eff ON true` exposing all three aggregates above
 * (`role_names`, `permissions`, `effective_roles`) off a SINGLE evaluation of
 * `effectiveRolesFrom(tm)` per outer row, instead of three separate ones.
 *
 * `${effectiveRolesFrom(tm)}` is itself a `WITH RECURSIVE` derived table, which
 * Postgres always materializes (an unconditional optimization fence — recursive CTEs
 * are never inlined/deduped across sibling references). Every roster-listing query
 * that needs all three aggregates used to splice them as three independent correlated
 * scalar subqueries, each re-running the ENTIRE ancestor walk for the same `${tm}` row
 * — three materializations where one suffices. Wrapping a single materialization of
 * `effectiveRolesFrom(tm)` in a `WITH ... AS MATERIALIZED` CTE (Postgres 12+, and this
 * repo targets Postgres 17 — see `docker-compose.db.yaml`) and computing all three
 * aggregates FROM that one CTE turns it into one evaluation per outer row.
 *
 * Callers splice this directly after the `FROM`/`JOIN` clauses that bring `${tm}` (a
 * `team_members` alias) into scope, then select `eff.role_names`, `eff.permissions`,
 * `eff.effective_roles` — column names match the standalone aggregates exactly, so this
 * is a drop-in replacement for the three-separate-subqueries shape.
 */
export const effectiveRolesAggLateral = (tm: string): string => `
  LEFT JOIN LATERAL (
    WITH eff_roles AS MATERIALIZED (
      SELECT * FROM ${effectiveRolesFrom(tm)} raw_er
    )
    SELECT
      ${roleNamesExpr('eff_roles')} AS role_names,
      ${permissionsExpr('eff_roles')} AS permissions,
      ${rolesJsonExpr('eff_roles')} AS effective_roles
  ) eff ON true
`;
