import * as Ix from 'dfx/Interactions/index';
import { EventCommand } from '~/commands/event/index.js';
import { FinanceCommand } from '~/commands/finance/index.js';
import { InfoCommand } from '~/commands/info/index.js';
import { JoinCommand } from '~/commands/join/index.js';
import { MakanickoCommand } from '~/commands/makanicko/index.js';

export const commandBuilder = Ix.builder
  .add(EventCommand)
  .add(MakanickoCommand)
  .add(FinanceCommand)
  .add(InfoCommand)
  .add(JoinCommand);
