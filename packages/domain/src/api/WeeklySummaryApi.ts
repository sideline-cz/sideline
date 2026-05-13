import { Schema, SchemaGetter } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import * as Team from '~/models/Team.js';
import { WeeklySummaryResponse } from '~/models/WeeklySummary.js';

const WeekParam = Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-W\d{2}$/)));

const BooleanFromString = Schema.Literals(['true', 'false']).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((s: 'true' | 'false') => s === 'true'),
    encode: SchemaGetter.transform((b: boolean) => (b ? 'true' : 'false') as 'true' | 'false'),
  }),
);

export class WeeklySummaryNotFound extends Schema.TaggedErrorClass<WeeklySummaryNotFound>()(
  'WeeklySummaryNotFound',
  {},
) {}

export class WeeklySummaryForbidden extends Schema.TaggedErrorClass<WeeklySummaryForbidden>()(
  'WeeklySummaryForbidden',
  {},
) {}

export class WeeklySummaryApiGroup extends HttpApiGroup.make('weeklySummary').add(
  HttpApiEndpoint.get('getWeeklySummary', '/teams/:teamId/weekly-summary', {
    success: WeeklySummaryResponse,
    error: [
      WeeklySummaryNotFound.pipe(HttpApiSchema.status(404)),
      WeeklySummaryForbidden.pipe(HttpApiSchema.status(403)),
    ],
    params: { teamId: Team.TeamId },
    query: {
      week: Schema.OptionFromOptional(WeekParam),
      includeTeam: Schema.OptionFromOptional(BooleanFromString),
    },
  }).middleware(AuthMiddleware),
) {}
