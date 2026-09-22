import type { EventType } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type { Locale } from '~/locale.js';

// The bot-side counterpart of applications/web/src/lib/event-labels.ts's `eventTypeLabels`:
// renders the built-in translated label for a `kind` when a seeded event type has never been
// renamed (`name` is `None`). Per-user locale, unlike the server, which has no reliable
// per-viewer locale to render this itself.
const KIND_LABELS: Record<EventType.EventTypeKind, (locale: Locale) => string> = {
  training: (locale) => m.event_type_training({}, { locale }),
  match: (locale) => m.event_type_match({}, { locale }),
  tournament: (locale) => m.event_type_tournament({}, { locale }),
  meeting: (locale) => m.event_type_meeting({}, { locale }),
  social: (locale) => m.event_type_social({}, { locale }),
  other: (locale) => m.event_type_other({}, { locale }),
};

export const eventTypeKindLabel = (kind: EventType.EventTypeKind, locale: Locale): string =>
  KIND_LABELS[kind](locale);
