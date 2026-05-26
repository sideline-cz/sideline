import { Effect } from 'effect';
import { client } from '~/lib/client';

export {
  clearLastTeamId,
  clearPendingDiscordJoin,
  clearPendingInvite,
  clearPendingOnboarding,
  finishLogin,
  getLastTeamId,
  getPendingDiscordJoin,
  getPendingInvite,
  getPendingOnboarding,
  getToken,
  logout,
  type PendingDiscordJoin,
  setLastTeamId,
  setPendingDiscordJoin,
  setPendingInvite,
  setPendingOnboarding,
} from '~/lib/token';

export const getLogin = () => client.pipe(Effect.flatMap((c) => c.auth.getLogin()));
