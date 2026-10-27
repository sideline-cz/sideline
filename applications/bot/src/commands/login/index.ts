import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { loginHandler } from './handler.js';

export const LoginCommand = Ix.global(
  {
    name: 'login',
    name_localizations: { cs: 'prihlasit' },
    description: m.bot_login_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_login_cmd_desc({}, { locale: 'cs' }) },
    // Allowed in DMs, unlike `/sudo`: the reply is a credential, and a DM is the most
    // private place it can land. `interactionUserId` resolves `user.id` when `member`
    // is absent, which is exactly the DM shape.
    dm_permission: true,
  } as const,
  loginHandler,
);
