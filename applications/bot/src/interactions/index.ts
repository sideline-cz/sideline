import * as Ix from 'dfx/Interactions/index';
import { AttendeesButton, AttendeesPageButton } from './attendees.js';
import {
  CarpoolAddButtonReg,
  CarpoolAddModal,
  CarpoolAssignButton,
  CarpoolAssignPickSelect,
  CarpoolCapacityButton,
  CarpoolCapacityModal,
  CarpoolKickButton,
  CarpoolKickPickSelect,
  CarpoolLeaveButtonReg,
  CarpoolLeaveMineButtonReg,
  CarpoolRemoveButtonReg,
  CarpoolReserveButtonReg,
} from './carpool.js';
import { ClaimButton, UnclaimButton } from './claim.js';
import {
  EmailApproveButton,
  EmailRejectButton,
  EmailSendOriginalButton,
} from './email-approval.js';
import {
  EmailDetailOpenButton,
  EmailDetailPageButton,
  EmailOriginalOpenButton,
  EmailOriginalPageButton,
} from './email-pages.js';
import { EventCreateModal } from './event-create.js';
import { EventCreateAutocomplete } from './event-create-autocomplete.js';
import { MakanickoLogAutocomplete } from './makanicko-log-autocomplete.js';
import {
  PollAddButtonReg,
  PollAddModalReg,
  PollCloseButtonReg,
  PollOpenButtonReg,
  PollRemoveButtonReg,
  PollRemoveSelectSubmitReg,
  PollVoteButtonReg,
  PollVotersButtonReg,
} from './poll.js';
import { ProfileCompleteModal } from './profile-complete.js';
import { RosterApproveButton, RosterDeclineButton } from './roster-approval.js';
import { RsvpAddMessageButton, RsvpButton, RsvpClearMessageButton, RsvpModal } from './rsvp.js';
import { SudoLeaveButtonReg } from './sudo.js';
import { TrainingResultAutocomplete } from './training-result-autocomplete.js';
import {
  UpcomingAddMessageButton,
  UpcomingClearMessageButton,
  UpcomingRsvpButton,
  UpcomingRsvpModal,
} from './upcoming-rsvp.js';

export const interactionBuilder = Ix.builder
  .add(RsvpButton)
  .add(RsvpAddMessageButton)
  .add(RsvpClearMessageButton)
  .add(RsvpModal)
  .add(AttendeesButton)
  .add(AttendeesPageButton)
  .add(EventCreateModal)
  .add(UpcomingRsvpButton)
  .add(UpcomingAddMessageButton)
  .add(UpcomingClearMessageButton)
  .add(UpcomingRsvpModal)
  .add(EventCreateAutocomplete)
  .add(MakanickoLogAutocomplete)
  .add(TrainingResultAutocomplete)
  .add(ClaimButton)
  .add(UnclaimButton)
  .add(EmailApproveButton)
  .add(EmailSendOriginalButton)
  .add(EmailRejectButton)
  .add(EmailDetailOpenButton)
  .add(EmailOriginalOpenButton)
  .add(EmailDetailPageButton)
  .add(EmailOriginalPageButton)
  .add(CarpoolAddButtonReg)
  .add(CarpoolAddModal)
  .add(CarpoolReserveButtonReg)
  .add(CarpoolLeaveButtonReg)
  .add(CarpoolLeaveMineButtonReg)
  .add(CarpoolRemoveButtonReg)
  .add(CarpoolAssignButton)
  .add(CarpoolAssignPickSelect)
  .add(CarpoolCapacityButton)
  .add(CarpoolCapacityModal)
  .add(CarpoolKickButton)
  .add(CarpoolKickPickSelect)
  .add(RosterApproveButton)
  .add(RosterDeclineButton)
  .add(PollOpenButtonReg)
  .add(PollVoteButtonReg)
  .add(PollAddButtonReg)
  .add(PollAddModalReg)
  .add(PollCloseButtonReg)
  .add(PollVotersButtonReg)
  .add(PollRemoveButtonReg)
  .add(PollRemoveSelectSubmitReg)
  .add(SudoLeaveButtonReg)
  .add(ProfileCompleteModal);
