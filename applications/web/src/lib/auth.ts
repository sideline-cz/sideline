import { Effect } from 'effect';
import { client } from '~/lib/client';

export {
  clearLastTeamId,
  clearPendingInvite,
  clearPendingOnboarding,
  finishLogin,
  getLastTeamId,
  getPendingInvite,
  getPendingOnboarding,
  getToken,
  logout,
  setLastTeamId,
  setPendingInvite,
  setPendingOnboarding,
} from '~/lib/token';

export const getLogin = () => client.pipe(Effect.flatMap((c) => c.auth.getLogin()));
