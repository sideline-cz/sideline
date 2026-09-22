import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option, Redacted } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { buildIssueBody, createIssue, type GithubIssueError } from './githubIssue.js';

const AUTHOR = {
  displayName: 'Jane',
  discordUserId: '123',
  guildId: Option.some('999'),
};

/** Captures the outgoing request so the payload can be asserted on. */
const mockClient = (status: number, body: unknown) => {
  const seen: { request?: { url: string; headers: Record<string, string>; body: unknown } } = {};
  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.request = {
          url: request.url,
          headers: request.headers as unknown as Record<string, string>,
          body:
            request.body._tag === 'Uint8Array'
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : undefined,
        };
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }),
    ),
  );
  return { layer, seen };
};

const run = (status: number, body: unknown, type: 'bug' | 'feature' = 'bug') => {
  const { layer, seen } = mockClient(status, body);
  return Effect.runPromise(
    createIssue({
      repo: 'acme/widgets',
      token: Redacted.make('super-secret'),
      type,
      title: 'Button does nothing',
      body: 'It really does nothing.',
    }).pipe(Effect.provide(layer), Effect.result),
  ).then((result) => ({ result, seen }));
};

describe('buildIssueBody', () => {
  it('keeps the reporter description first and appends triage attribution', () => {
    const body = buildIssueBody({
      description: 'The RSVP button is dead.',
      author: AUTHOR,
      botVersion: '1.2.3',
    });

    expect(body.startsWith('The RSVP button is dead.')).toBe(true);
    expect(body).toContain('Jane');
    expect(body).toContain('123');
    expect(body).toContain('999');
    expect(body).toContain('1.2.3');
  });

  it('says "direct message" when there is no guild', () => {
    const body = buildIssueBody({
      description: 'x',
      author: { ...AUTHOR, guildId: Option.none() },
      botVersion: '1.2.3',
    });

    expect(body).toContain('direct message');
  });
});

describe('createIssue', () => {
  it('returns the issue url on a 201', async () => {
    const { result } = await run(201, {
      html_url: 'https://github.com/acme/widgets/issues/7',
      number: 7,
    });

    expect(result._tag).toBe('Success');
    expect((result as { success: string }).success).toBe(
      'https://github.com/acme/widgets/issues/7',
    );
  });

  it('never puts the token in the request body', async () => {
    const { seen } = await run(201, { html_url: 'https://x/1', number: 1 });

    expect(JSON.stringify(seen.request?.body)).not.toContain('super-secret');
    expect(seen.request?.body).toStrictEqual({
      title: 'Button does nothing',
      body: 'It really does nothing.',
      labels: ['bug'],
    });
  });

  it('sends the token as a bearer header against the configured repo', async () => {
    const { seen } = await run(201, { html_url: 'https://x/1', number: 1 });

    expect(seen.request?.url).toBe('https://api.github.com/repos/acme/widgets/issues');
    expect(seen.request?.headers.authorization).toBe('Bearer super-secret');
  });

  it('maps a feature report onto the enhancement label', async () => {
    const { seen } = await run(201, { html_url: 'https://x/1', number: 1 }, 'feature');

    expect(seen.request?.body).toStrictEqual({
      title: 'Button does nothing',
      body: 'It really does nothing.',
      labels: ['enhancement'],
    });
  });

  it('fails with `rejected` on a non-201 (bad token, invisible repo, validation)', async () => {
    const { result } = await run(401, { message: 'Bad credentials' });

    expect(result._tag).toBe('Failure');
    expect((result as { failure: GithubIssueError }).failure.reason).toBe('rejected');
    expect((result as { failure: GithubIssueError }).failure.status).toBe(401);
  });

  it('fails with `malformed_response` when a 201 body has no url', async () => {
    const { result } = await run(201, { unexpected: true });

    expect(result._tag).toBe('Failure');
    expect((result as { failure: GithubIssueError }).failure.reason).toBe('malformed_response');
  });
});
