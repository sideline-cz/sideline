import { Discord } from 'dfx';

/**
 * Bits that must never be silently handed to whoever holds a `role:manage`-managed Discord role.
 * `ADMINISTRATOR` implies every other permission (including these five), so it alone would be
 * sufficient — the rest are listed explicitly because each is independently dangerous (mass ban/
 * kick, channel takeover, granting further roles) even without full admin.
 */
export const DANGEROUS_PERMISSIONS_MASK =
  Discord.Permissions.Administrator |
  Discord.Permissions.ManageGuild |
  Discord.Permissions.ManageRoles |
  Discord.Permissions.ManageChannels |
  Discord.Permissions.BanMembers |
  Discord.Permissions.KickMembers;

/**
 * `true` when `permissions` (Discord's decimal-string bitfield, as returned on a guild role)
 * carries any bit from {@link DANGEROUS_PERMISSIONS_MASK}.
 *
 * Fails CLOSED on a malformed input (empty string, non-numeric, etc.) — a permissions string
 * that cannot be parsed is treated as dangerous rather than silently treated as zero. This is the
 * point-of-use re-validation for blocker 3: an adopted or created role's permissions can change in
 * Discord at any time after the mapping is written (a guild admin can grant `ADMINISTRATOR` to a
 * role Sideline is still assigning), so the safety check must run again immediately before
 * `addGuildMemberRole`, not only once at mapping time.
 */
// `BigInt('')` and `BigInt('  ')` do NOT throw — both coerce to `0n`, the same trap `Number('')`
// sets for a naive rewrite of this check (see AGENTS.md-referenced nit on `pickAdoptableRole`'s
// permissions guard). Validate the wire shape explicitly before parsing so an empty/blank/
// non-numeric string fails closed instead of silently decoding to "no permissions".
const isDecimalBitfield = (permissions: string): boolean => /^\d+$/.test(permissions);

export const hasDangerousPermissions = (permissions: string): boolean => {
  if (!isDecimalBitfield(permissions)) return true;
  try {
    return (BigInt(permissions) & DANGEROUS_PERMISSIONS_MASK) !== BigInt(0);
  } catch {
    return true;
  }
};
