import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi';

export class VersionInfo extends Schema.Class<VersionInfo>('VersionInfo')({
  server: Schema.String,
  bot: Schema.String,
}) {}

export class VersionApiGroup extends HttpApiGroup.make('version').add(
  HttpApiEndpoint.get('get', '/version', {
    success: VersionInfo,
  }),
) {}
