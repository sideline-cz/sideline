import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';

/**
 * The single `/complete` (`/dokoncit`) profile modal, shared by every entry point:
 * the slash command (`commands/complete/handler.ts`), the stateless `profile-verify`
 * button (`interactions/profile-verify.ts`) and the read-only channel's pinned embed
 * (`rest/channels/ensureVerificationChannel.ts`). One builder, one `custom_id`
 * (`profile-complete`, stateless) — the whole point of moving gender collection off
 * the entry `custom_id` and into the form itself (Task 6, architect ask #2).
 *
 * Three `type: 1` action rows (text inputs, unchanged mechanism) plus one `type: 18`
 * Label component wrapping a `type: 3` string select for gender. This is the "mixed
 * action-row + label" payload the plan's Task 0 spike confirms Discord accepts.
 *
 * If a later live smoke test disproves that and Discord rejects the mixed payload,
 * the documented fallback (design spec §2.2) swaps this file's `components` array for
 * an all-`type: 18` version (or, if label components are rejected outright, drops the
 * gender field entirely and reintroduces a three-button `profile-verify:{gender}`
 * intermediate step in `interactions/profile-verify.ts`). Either way the swap is
 * isolated to this one file — every caller only ever sees `buildProfileCompleteModal`'s
 * return value, never its internal shape.
 */
export const buildProfileCompleteModal = (
  locale: Locale,
): Discord.ModalInteractionCallbackRequestData => ({
  custom_id: 'profile-complete',
  title: m.bot_complete_modal_title({}, { locale }),
  components: [
    UI.row([
      UI.textInput({
        custom_id: 'profile_name',
        label: m.bot_complete_name_label({}, { locale }),
        style: Discord.TextInputStyleTypes.SHORT,
        required: true,
        placeholder: m.bot_complete_name_placeholder({}, { locale }),
        max_length: 100,
      }),
    ]),
    UI.row([
      UI.textInput({
        custom_id: 'profile_birth_date',
        label: m.bot_complete_birth_date_label({}, { locale }),
        style: Discord.TextInputStyleTypes.SHORT,
        required: true,
        placeholder: m.bot_complete_birth_date_placeholder({}, { locale }),
        max_length: 10,
      }),
    ]),
    UI.row([
      UI.textInput({
        custom_id: 'profile_jersey_number',
        label: m.bot_complete_jersey_label({}, { locale }),
        style: Discord.TextInputStyleTypes.SHORT,
        required: false,
        placeholder: m.bot_complete_jersey_placeholder({}, { locale }),
        max_length: 2,
      }),
    ]),
    {
      type: 18,
      label: m.bot_complete_gender_label({}, { locale }),
      description: m.bot_complete_gender_description({}, { locale }),
      component: {
        type: 3,
        custom_id: 'profile_gender',
        required: true,
        min_values: 1,
        max_values: 1,
        placeholder: m.bot_complete_gender_placeholder({}, { locale }),
        options: [
          { value: 'male', label: m.gender_male({}, { locale }) },
          { value: 'female', label: m.gender_female({}, { locale }) },
          { value: 'other', label: m.gender_other({}, { locale }) },
        ],
      },
    } satisfies Discord.LabelComponentForModalRequest,
  ],
});
