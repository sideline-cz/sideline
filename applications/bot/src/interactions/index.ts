import * as Ix from 'dfx/Interactions/index';
import { AttendeesButton, AttendeesPageButton } from './attendees.js';
import {
  CarpoolAddButtonReg,
  CarpoolAddModal,
  CarpoolAssignButton,
  CarpoolAssignPickSelect,
  CarpoolLeaveButtonReg,
  CarpoolRemoveButtonReg,
  CarpoolReserveButtonReg,
} from './carpool.js';
import { ClaimButton, UnclaimButton } from './claim.js';
import { EventCreateModal } from './event-create.js';
import { EventCreateAutocomplete } from './event-create-autocomplete.js';
import { MakanickoLogAutocomplete } from './makanicko-log-autocomplete.js';
import { OverviewShowButton } from './overview-channel.js';
import { RsvpAddMessageButton, RsvpButton, RsvpClearMessageButton, RsvpModal } from './rsvp.js';
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
  .add(OverviewShowButton)
  .add(EventCreateAutocomplete)
  .add(MakanickoLogAutocomplete)
  .add(ClaimButton)
  .add(UnclaimButton)
  .add(CarpoolAddButtonReg)
  .add(CarpoolAddModal)
  .add(CarpoolReserveButtonReg)
  .add(CarpoolLeaveButtonReg)
  .add(CarpoolRemoveButtonReg)
  .add(CarpoolAssignButton)
  .add(CarpoolAssignPickSelect);
