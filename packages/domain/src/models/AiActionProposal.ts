import { Schema } from 'effect';

// UUID-checked: a malformed id would otherwise hit the `UUID` column, raise `22P02`, and
// surface as a 500 defect through `catchSqlErrors` instead of the clean 404 this id's whole
// endpoint taxonomy promises.
export const AiActionProposalId = Schema.String.pipe(
  Schema.check(Schema.isUUID()),
  Schema.brand('AiActionProposalId'),
);
export type AiActionProposalId = typeof AiActionProposalId.Type;

// Closed union of proposable actions. Adding a case here is meant to force a compile error at
// every switch over `AiActionName` (the tool registry, the executor) until each is updated.
export const AiActionName = Schema.Literals(['create_event']);
export type AiActionName = typeof AiActionName.Type;
