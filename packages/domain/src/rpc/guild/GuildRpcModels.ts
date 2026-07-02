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
