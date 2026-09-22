import { Data, Effect, Option, pipe, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

export type ReportType = 'bug' | 'feature';

/** GitHub's own label names — `bug` and `enhancement` are the two default
 * labels every repository ships with, so neither needs creating first. */
const LABELS: Record<ReportType, string> = { bug: 'bug', feature: 'enhancement' };

export class GithubIssueError extends Data.TaggedError('GithubIssueError')<{
  readonly reason: 'request_failed' | 'rejected' | 'malformed_response';
  readonly status?: number;
}> {}

const IssueResponse = Schema.Struct({ html_url: Schema.String, number: Schema.Number });

export interface ReportAuthor {
  readonly displayName: string;
  readonly discordUserId: string;
  readonly guildId: Option.Option<string>;
}

/**
 * The reporter never sees the issue body, so everything a triager needs to
 * reproduce has to be baked in here: who filed it, from which guild, and which
 * bot build they were on. Discord ids (not names) are what the database is
 * keyed by — the display name alone is unresolvable a week later.
 */
export const buildIssueBody = (input: {
  readonly description: string;
  readonly author: ReportAuthor;
  readonly botVersion: string;
}): string =>
  [
    input.description,
    '',
    '---',
    `Reported via \`/report\` by **${input.author.displayName}** (\`${input.author.discordUserId}\`)`,
    `Guild: ${Option.getOrElse(input.author.guildId, () => 'direct message')}`,
    `Bot version: \`${input.botVersion}\``,
  ].join('\n');

export const createIssue = (input: {
  readonly repo: string;
  readonly token: Redacted.Redacted<string>;
  readonly type: ReportType;
  readonly title: string;
  readonly body: string;
}): Effect.Effect<string, GithubIssueError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;

    const request = yield* pipe(
      HttpClientRequest.post(`https://api.github.com/repos/${input.repo}/issues`),
      HttpClientRequest.setHeaders({
        Authorization: `Bearer ${Redacted.value(input.token)}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'sideline-bot',
      }),
      // Explicit fields — never spread `input`, which carries the token.
      (base) =>
        HttpClientRequest.bodyJson(base, {
          title: input.title,
          body: input.body,
          labels: [LABELS[input.type]],
        }),
      Effect.mapError(() => new GithubIssueError({ reason: 'request_failed' })),
    );

    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new GithubIssueError({ reason: 'request_failed' })));

    // `execute` does not fail on a non-2xx (see `FioApiClient`), so the status
    // is checked here. A bad token, a repo the token cannot see and a
    // validation error are all the same thing to the reporter: nothing was
    // filed, and no wording they choose will change that.
    if (response.status !== 201) {
      return yield* new GithubIssueError({ reason: 'rejected', status: response.status });
    }

    const decoded = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(IssueResponse)),
      Effect.mapError(() => new GithubIssueError({ reason: 'malformed_response' })),
    );

    return decoded.html_url;
  });
