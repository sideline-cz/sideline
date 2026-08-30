import { Array as Arr, Number as Num, Option, Order, pipe } from 'effect';

/**
 * The subset of dfx's `GuildRoleResponse` that the adoption rule needs.
 */
export interface AdoptableCandidateRole {
  readonly id: string;
  readonly name: string;
  readonly permissions: string;
  readonly position: number;
  readonly managed: boolean;
}

// Secondary key on `id` breaks ties deterministically — Discord does not document `position`
// as unique or `listGuildRoles`'s return order as stable, so relying on `Arr.sort`'s stability
// alone over an undocumented order is not a guarantee.
const byLowestPosition = Order.combine(
  Order.mapInput(Num.Order, (role: AdoptableCandidateRole) => role.position),
  Order.mapInput(Order.String, (role: AdoptableCandidateRole) => role.id),
);

/**
 * Selects an existing Discord guild role that Sideline can safely adopt for `roleName` instead of
 * creating a new one.
 *
 * A candidate must satisfy ALL of:
 * - exact, case-sensitive name match
 * - `managed === false` — bot/integration-owned roles cannot be assigned by us
 * - `permissions === '0'` — a strict string compare against Discord's zero **guild-level**
 *   bitfield; any non-zero permission (e.g. `ADMINISTRATOR`) is rejected, never masked. This only
 *   bounds guild-level permissions — per-channel permission overwrites are invisible here, so an
 *   adopted role can still convey e.g. `VIEW_CHANNEL` on a private channel via an overwrite.
 *   `ADMINISTRATOR` itself cannot originate from an overwrite, so the privilege-escalation ceiling
 *   this check exists to prevent is still guild-scoped; the residual risk is channel-scoped.
 * - `position < botTopPosition` — Discord rejects assigning a role at or above the bot's own top
 *   role with a terminal 50013
 *
 * Among survivors, the lowest `position` wins — furthest below the bot, so the least likely to be
 * invalidated by a later hierarchy change. Returns `None` when nothing qualifies, so the caller
 * falls through to creating a fresh, zero-permission role.
 */
export const pickAdoptableRole = (
  roles: ReadonlyArray<AdoptableCandidateRole>,
  roleName: string,
  botTopPosition: number,
): Option.Option<{ readonly id: string; readonly position: number }> =>
  pipe(
    roles,
    Arr.filter(
      (role) =>
        role.name === roleName &&
        !role.managed &&
        role.permissions === '0' &&
        role.position < botTopPosition,
    ),
    Arr.sort(byLowestPosition),
    Arr.head,
    Option.map((role) => ({ id: role.id, position: role.position })),
  );
