import * as m from '@sideline/i18n/messages';
import * as Ix from 'dfx/Interactions/index';
import { completeHandler } from './handler.js';

// The `gender` option is gone — Task 6 moved gender collection into the modal
// itself (see `~/commands/complete/modal.js`), so the handler now just opens
// the modal. Removing a required command option is a compatible definition
// update; no migration for existing installs is needed.
export const CompleteCommand = Ix.global(
  {
    name: 'complete',
    name_localizations: { cs: 'dokoncit' },
    description: m.bot_complete_cmd_desc({}, { locale: 'en' }),
    description_localizations: { cs: m.bot_complete_cmd_desc({}, { locale: 'cs' }) },
    dm_permission: false,
  } as const,
  completeHandler,
);
