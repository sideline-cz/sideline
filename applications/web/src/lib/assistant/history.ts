/**
 * Client-side mirror of the server's history truncation (plan
 * `.work-plans/ai-app-interaction.md` §9, §13.11; design §2.6). `buildHistory` honours
 * BOTH `HISTORY_CHAR_BUDGET` (the same 8000 the server enforces) and
 * `HISTORY_MAX_MESSAGES` (the wire schema's 20-message cap), accumulating from the
 * newest message backwards and dropping only whole messages from the front — never a
 * partial one. The newest message is always kept, even alone over budget, so the user's
 * own just-submitted turn is never silently eaten. `droppedCount` lets the UI render the
 * `assistant_historyTrimmed` divider instead of silently disagreeing with the server
 * about what the model saw.
 */

export const HISTORY_CHAR_BUDGET = 8000;
export const HISTORY_MAX_MESSAGES = 20;

export interface HistoryTurn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface BuiltHistory<T extends HistoryTurn> {
  readonly messages: ReadonlyArray<T>;
  readonly droppedCount: number;
}

export const buildHistory = <T extends HistoryTurn>(turns: ReadonlyArray<T>): BuiltHistory<T> => {
  const included: Array<T> = [];
  let totalChars = 0;

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    const isNewest = included.length === 0;
    const wouldExceedChars = totalChars + turn.content.length > HISTORY_CHAR_BUDGET;
    const wouldExceedCount = included.length >= HISTORY_MAX_MESSAGES;

    if (!isNewest && (wouldExceedChars || wouldExceedCount)) {
      break;
    }

    included.unshift(turn);
    totalChars += turn.content.length;
  }

  return { messages: included, droppedCount: turns.length - included.length };
};
