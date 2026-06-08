import { Schema } from 'effect';

export class EmailApprovalForbidden extends Schema.TaggedErrorClass<EmailApprovalForbidden>()(
  'EmailApprovalForbidden',
  {},
) {}

export class EmailRpcMessageNotFound extends Schema.TaggedErrorClass<EmailRpcMessageNotFound>()(
  'EmailRpcMessageNotFound',
  {},
) {}
