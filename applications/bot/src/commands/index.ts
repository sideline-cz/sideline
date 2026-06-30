import * as Ix from 'dfx/Interactions/index';
import { CarpoolCommand } from '~/commands/carpool/index.js';
import { EventCommand } from '~/commands/event/index.js';
import { FinanceCommand } from '~/commands/finance/index.js';
import { InfoCommand } from '~/commands/info/index.js';
import { MakanickoCommand } from '~/commands/makanicko/index.js';
import { PollCommand } from '~/commands/poll/index.js';
import { RefreshEventsCommand } from '~/commands/refreshEvents/index.js';
import { SummarizeCommand } from '~/commands/summarize/index.js';
import { SummonCommand } from '~/commands/summon/index.js';
import { TrainingCommand } from '~/commands/training/index.js';

export const commandBuilder = Ix.builder
  .add(EventCommand)
  .add(MakanickoCommand)
  .add(FinanceCommand)
  .add(InfoCommand)
  .add(SummonCommand)
  .add(SummarizeCommand)
  .add(CarpoolCommand)
  .add(TrainingCommand)
  .add(PollCommand)
  .add(RefreshEventsCommand);
