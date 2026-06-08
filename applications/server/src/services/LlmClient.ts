import { Data, Effect, Layer, Option, pipe, Redacted, Schema, ServiceMap } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { env } from '~/env.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LlmError extends Data.TaggedError('LlmError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Input type
// ---------------------------------------------------------------------------

export interface SummarizeEmailInput {
  readonly subject: string;
  readonly from: string;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

interface LlmClientService {
  readonly summarizeEmail: (input: SummarizeEmailInput) => Effect.Effect<string, LlmError>;
}

// ---------------------------------------------------------------------------
// Stub provider
// ---------------------------------------------------------------------------

const makeStub = (): LlmClientService => ({
  summarizeEmail: ({ subject, from, body }) =>
    Effect.succeed(
      `Summary of "${subject}" from ${from}: ${body.slice(0, 280)}${body.length > 280 ? '...' : ''}`,
    ),
});

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const OpenAiResponseSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        content: Schema.OptionFromNullOr(Schema.String),
      }),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Real OpenAI-compatible provider
// ---------------------------------------------------------------------------

const makeReal = (
  apiUrl: string,
  apiKey: Redacted.Redacted<string>,
  model: string,
): LlmClientService => ({
  summarizeEmail: ({ subject, from, body }) => {
    const requestBody = {
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant that summarizes emails concisely. Provide a brief, informative summary in 2-4 sentences.',
        },
        {
          role: 'user',
          content: `Please summarize the following email.\nSubject: ${subject}\nFrom: ${from}\n\nEmail body:\n${body}`,
        },
      ],
      max_tokens: 500,
    };

    const baseRequest = pipe(
      HttpClientRequest.post(`${apiUrl}/chat/completions`),
      HttpClientRequest.setHeader('Authorization', `Bearer ${Redacted.value(apiKey)}`),
    );

    return pipe(
      HttpClientRequest.bodyJson(baseRequest, requestBody),
      Effect.flatMap((request) => HttpClient.execute(request)),
      Effect.flatMap((response) => response.json),
      Effect.flatMap((raw) =>
        Schema.decodeUnknownEffect(OpenAiResponseSchema)(raw).pipe(
          Effect.mapError(
            (e) => new LlmError({ message: `LLM response parse failed: ${String(e)}`, cause: e }),
          ),
        ),
      ),
      Effect.flatMap((parsed) => {
        const choice = parsed.choices[0];
        if (choice === undefined) {
          return Effect.fail(new LlmError({ message: 'LLM returned no choices' }));
        }
        return Option.match(choice.message.content, {
          onNone: () => Effect.fail(new LlmError({ message: 'LLM returned null content' })),
          onSome: (text) => Effect.succeed(text),
        });
      }),
      Effect.mapError((e) => {
        if (e instanceof LlmError) return e;
        return new LlmError({ message: `LLM request failed: ${String(e)}`, cause: e });
      }),
      Effect.provide(FetchHttpClient.layer),
    );
  },
});

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make: Effect.Effect<LlmClientService> = Effect.Do.pipe(
  Effect.let('apiUrl', () => env.LLM_API_URL ?? ''),
  Effect.let('apiKeyOpt', () => env.LLM_API_KEY),
  Effect.let('model', () => env.LLM_MODEL ?? 'gpt-4o-mini'),
  Effect.tap(({ apiUrl, apiKeyOpt }) => {
    if (apiUrl === '' || Option.isNone(apiKeyOpt)) {
      return Effect.logWarning(
        'LlmClient: no LLM API configured — using deterministic stub provider',
      );
    }
    return Effect.void;
  }),
  Effect.map(({ apiUrl, apiKeyOpt, model }) => {
    if (apiUrl === '' || Option.isNone(apiKeyOpt)) {
      return makeStub();
    }
    return makeReal(apiUrl, apiKeyOpt.value, model);
  }),
);

export class LlmClient extends ServiceMap.Service<LlmClient, LlmClientService>()('api/LlmClient') {
  static readonly Default = Layer.effect(LlmClient, make);
}
