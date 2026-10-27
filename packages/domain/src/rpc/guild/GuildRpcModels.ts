import { Schema } from 'effect';

export class CompleteProfileGuildNotFound extends Schema.TaggedErrorClass<CompleteProfileGuildNotFound>()(
  'CompleteProfileGuildNotFound',
  {},
) {}

export class CompleteProfileNotMember extends Schema.TaggedErrorClass<CompleteProfileNotMember>()(
  'CompleteProfileNotMember',
  {},
) {}

export class CompleteProfileInvalidInput extends Schema.TaggedErrorClass<CompleteProfileInvalidInput>()(
  'CompleteProfileInvalidInput',
  {},
) {}

/** The Discord user has no `users` row — they have never logged in and were never
 * registered by the bot. `IssueLoginLink` refuses rather than minting an account:
 * creating a Sideline identity from a login request is a different trust decision. */
export class LoginLinkUserNotFound extends Schema.TaggedErrorClass<LoginLinkUserNotFound>()(
  'LoginLinkUserNotFound',
  {},
) {}

/** Too many links asked for. `retry_after_seconds` is whole seconds until the violated
 * window resets. */
export class LoginLinkRateLimited extends Schema.TaggedErrorClass<LoginLinkRateLimited>()(
  'LoginLinkRateLimited',
  { retry_after_seconds: Schema.Number },
) {}
