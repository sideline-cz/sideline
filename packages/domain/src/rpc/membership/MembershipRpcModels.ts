import { Schema } from 'effect';
import * as Fee from '~/models/Fee.js';
import {
  FreeTrainingsIncluded,
  MembershipPlanId,
  MembershipPlanName,
} from '~/models/MembershipPlan.js';

export class MembershipPlanView extends Schema.Class<MembershipPlanView>('MembershipPlanView')({
  plan_id: MembershipPlanId,
  // None = render the built-in translated label for the seeded default plan, same as the web.
  name: Schema.OptionFromNullOr(MembershipPlanName),
  price_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  price_per_training_minor: Fee.AmountMinor,
  free_trainings_included: FreeTrainingsIncluded,
  is_default: Schema.Boolean,
}) {}

export class MembershipSelectionView extends Schema.Class<MembershipSelectionView>(
  'MembershipSelectionView',
)({
  // Active plans only, default first — whatever `findMembershipPlansByTeamId` returns.
  plans: Schema.Array(MembershipPlanView),
  // None = never picked. NOT "on the default plan": the default is the plan whose `is_default`
  // is set, and the bot resolves the effective plan from `plans` exactly like the web does.
  selected_plan_id: Schema.OptionFromNullOr(MembershipPlanId),
  // None = selection is always open. The GOVERNING season's raw `selection_deadline` — never a
  // LEAST() of it and the expiry, or the bot could not tell the two closed states apart.
  // UNCHANGED (required key, OptionFromNullOr): the server has always emitted it.
  deadline: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  // The SAME governing season's expiry. `OptionFromOptionalKey`, never `OptionFromNullOr`: the
  // rolling deploy order is bot -> server -> web, so the NEW bot decodes an OLD server's payload
  // where this key is simply ABSENT (`applications/server/AGENTS.md` rule 2). A required key here
  // 500s the /membership board and every ephemeral picker for the whole window between the bot
  // rolling and the server rolling. Degrading in the direction that actually happens: absent ->
  // None -> "not ended" -> the bot shows the deadline line, exactly as it does today.
  season_expires_at: Schema.OptionFromOptionalKey(Schema.DateTimeUtcFromString),
  // Gates `/membership` — only a fee manager may post the board. A field and not an error: the
  // same RPC serves the board command and every member's picker, and only the former cares.
  can_manage: Schema.Boolean,
}) {}

export class MembershipGuildNotFound extends Schema.TaggedErrorClass<MembershipGuildNotFound>()(
  'MembershipGuildNotFound',
  {},
) {}

export class MembershipNotMember extends Schema.TaggedErrorClass<MembershipNotMember>()(
  'MembershipNotMember',
  {},
) {}

// Deliberately NOT named `MembershipPlanNotFound` / `MembershipSelectionClosed` — those tags are
// already taken by `MembershipPlanApi`'s HTTP errors, and two Schema classes sharing a tag in one
// bundle is a decode hazard.
export class MembershipPlanUnavailable extends Schema.TaggedErrorClass<MembershipPlanUnavailable>()(
  'MembershipPlanUnavailable',
  {},
) {}

export class MembershipSelectionLocked extends Schema.TaggedErrorClass<MembershipSelectionLocked>()(
  'MembershipSelectionLocked',
  {},
) {}
