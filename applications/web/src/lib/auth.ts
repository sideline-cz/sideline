import { Effect } from 'effect';
import { client } from '~/lib/client';

export {
  clearPendingDiscordJoin,
  clearPendingInvite,
  finishLogin,
  getLastTeamId,
  getPendingDiscordJoin,
  getPendingInvite,
  getToken,
  logout,
  type PendingDiscordJoin,
  setLastTeamId,
  setPendingDiscordJoin,
  setPendingInvite,
} from '~/lib/token';

export const getLogin = () => client.pipe(Effect.flatMap((c) => c.auth.getLogin()));
