// Plan `.work-plans/command-palette-search.md` §D — the route's own hand-off effect, in
// `routes/(authenticated)/teams/$teamId/assistant.tsx`:
//   - `ask?.trim().slice(0, 2000)` (the blocker fix: `new AiChatApi.ChatMessage(...)` throws
//     over 2000 chars, so this must happen before `AssistantConversation`'s own composer guard
//     ever runs for an auto-sent question).
//   - `setPending({ text, id })` only when the trimmed/clamped text is non-empty.
//   - `navigate({ search: {}, replace: true })` — exact form: clears every search param, no
//     `to`/`params` (stays on the current route), `replace: true` so a refresh/Back never
//     re-sends `?ask=`.
//
// `AssistantConversation.test.tsx` covers the downstream 2000-char clamp thoroughly (the
// composer's OWN guard); nothing there exercises this route's one-shot capture. Tested here by
// mocking `@tanstack/react-router`'s `createFileRoute` down to a stub that hands back
// controllable `useParams`/`useLoaderData`/`useSearch`/`useNavigate` — the file-based `Route`
// object is otherwise only resolvable inside a real, fully wired router (no route in this repo
// is tested through one; see `AuthenticatedLayout.test.tsx`/`CommandPalette.test.tsx` for the
// component-level convention this follows instead) — and rendering `Route.options.component`
// (exactly what TanStack Router itself would render) directly, with `AssistantPage` mocked out
// to a prop-recording spy so the assertions land on exactly what the route hands it.

import { act, render } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The synchronous half of the `no 400` claim: `AssistantSearchSchema` carries no length check
// (the route header comment says as much — `.slice(0, 2000)` in the effect below is the clamp,
// deliberately not a `validateSearch` rejection). Calling the real, un-mocked
// `Route.options.validateSearch` (standard-schema's `~standard.validate`) with a hand-crafted,
// oversized `?ask=` and asserting a `.value` (never `.issues`) pins that a giant URL never turns
// into a `validateSearch` failure / route error boundary.

// The minimal slice of the standard-schema spec (`@standard-schema/spec`, what
// `Schema.toStandardSchemaV1` returns) this file needs — typed by hand instead of imported so
// this test does not depend on a transitive package never declared in this workspace's
// `package.json`.
interface StandardSchemaLike {
  readonly '~standard': {
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: unknown; readonly issues?: undefined }
      | { readonly value?: undefined; readonly issues: ReadonlyArray<unknown> };
  };
}

function hasStandardValidate(value: unknown): value is StandardSchemaLike {
  return typeof value === 'object' && value !== null && '~standard' in value;
}

// Bridging through an `unknown`-typed parameter (rather than checking `Route.options.*`
// in place) is deliberate: TanStack Router's own declared types for `component`/
// `validateSearch` are wide unions this test has no reason to reproduce, and control-flow
// narrowing does not survive being captured by a function declared later (`setup` below) —
// these two small asserts are the cast-free way to get a single concrete type out once, here.
function assertComponent<T>(component: T | undefined): T {
  if (component === undefined) {
    throw new Error('AssistantRoute must define a component');
  }
  return component;
}

function assertStandardSchema(value: unknown): StandardSchemaLike {
  if (!hasStandardValidate(value)) {
    throw new Error('AssistantRoute.validateSearch must be a standard-schema validator');
  }
  return value;
}

interface FileRouteOptions {
  readonly component: React.ComponentType;
  readonly validateSearch: unknown;
}

const { mockUseParams, mockUseLoaderData, mockUseSearch, mockNavigate } = vi.hoisted(() => ({
  mockUseParams: vi.fn(),
  mockUseLoaderData: vi.fn(),
  mockUseSearch: vi.fn(),
  mockNavigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: FileRouteOptions) => ({
    options,
    useParams: mockUseParams,
    useLoaderData: mockUseLoaderData,
    useSearch: mockUseSearch,
    useNavigate: () => mockNavigate,
  }),
}));

interface AssistantPageProps {
  teamId: string;
  enabled: boolean;
  pendingQuestion?: { text: string; id: number };
}

const { mockAssistantPage } = vi.hoisted(() => ({ mockAssistantPage: vi.fn() }));

vi.mock('~/components/pages/AssistantPage', () => ({
  AssistantPage: (props: AssistantPageProps) => {
    mockAssistantPage(props);
    return null;
  },
}));

const { Route } = await import('~/routes/(authenticated)/teams/$teamId/assistant.tsx');
const Component = assertComponent(Route.options.component);

function setup(ask: string | undefined) {
  mockUseParams.mockReturnValue({ teamId: 'team-1' });
  mockUseLoaderData.mockReturnValue({ enabled: true });
  mockUseSearch.mockReturnValue({ ask });
  return render(<Component />);
}

function lastPendingQuestion(): AssistantPageProps['pendingQuestion'] {
  const lastCall = mockAssistantPage.mock.calls.at(-1);
  return lastCall?.[0]?.pendingQuestion;
}

beforeEach(() => {
  mockUseParams.mockReset();
  mockUseLoaderData.mockReset();
  mockUseSearch.mockReset();
  mockNavigate.mockReset();
  mockAssistantPage.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AssistantRoute hand-off effect (plan §D)', () => {
  it('clamps a 3000-char ask to exactly 2000 chars before handing it to AssistantPage', async () => {
    const huge = 'x'.repeat(3000);
    await act(async () => {
      setup(huge);
    });

    const pending = lastPendingQuestion();
    expect(pending?.text).toHaveLength(2000);
    expect(pending?.text).toBe(huge.slice(0, 2000));
    expect(mockNavigate).toHaveBeenCalledWith({ search: {}, replace: true });
  });

  it('an empty ask ("") sets no pending question and never navigates', async () => {
    await act(async () => {
      setup('');
    });

    expect(lastPendingQuestion()).toBeUndefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a whitespace-only ask sets no pending question and never navigates', async () => {
    await act(async () => {
      setup('   ');
    });

    expect(lastPendingQuestion()).toBeUndefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('a normal ask is handed to AssistantPage verbatim, and the route strips it via navigate({ search: {}, replace: true })', async () => {
    await act(async () => {
      setup('What is on the schedule this week?');
    });

    const pending = lastPendingQuestion();
    expect(pending?.text).toBe('What is on the schedule this week?');
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith({ search: {}, replace: true });
  });

  it('an absent ask sets no pending question and never navigates', async () => {
    await act(async () => {
      setup(undefined);
    });

    expect(lastPendingQuestion()).toBeUndefined();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('the real validateSearch accepts a hand-crafted, oversized ?ask= — never a 400 into the route error boundary', () => {
    const huge = 'x'.repeat(5000);
    const validateSearch = assertStandardSchema(Route.options.validateSearch);
    const result = validateSearch['~standard'].validate({ ask: huge });
    expect(result).not.toHaveProperty('issues');
    expect(result.value).toEqual({ ask: huge });
  });
});
