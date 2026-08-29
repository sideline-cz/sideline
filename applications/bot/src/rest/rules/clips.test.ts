// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// These tests exist for one reason: the resolution clip reaching a shared
// message spoils the scenario for everyone still working through it, and that
// is a silent failure — the message looks fine, it just gives the answer away.
// Type-checking cannot catch it, so it is pinned here.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_PACKAGES } from '@sideline/rules/content';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChainMessage } from './buildChainMessage.js';
import { buildQuizMessage } from './buildQuizMessage.js';
import { quizPerms } from './perms.js';
import { replayAnswer } from './quizState.js';

const SCENARIO = ALL_PACKAGES.flatMap((p) => p.scenarios)[0];
if (SCENARIO === undefined) throw new Error('content has no scenarios');

const originalDir = process.env.RULES_GIF_DIR;

/** A directory holding both clips for `SCENARIO`, standing in for what the
 * Dockerfile's `gifs` stage bakes into the image. The bytes are not a real
 * GIF — nothing here decodes them, and using real ones would tie the test to
 * a 2-minute render. */
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'rules-clips-'));
  for (const kind of ['setup', 'resolution']) {
    writeFileSync(join(dir, `${SCENARIO.id}-${kind}.gif`), Buffer.from(`GIF89a-${kind}`));
  }
  process.env.RULES_GIF_DIR = dir;
});

afterEach(() => {
  if (originalDir === undefined) delete process.env.RULES_GIF_DIR;
  else process.env.RULES_GIF_DIR = originalDir;
});

const perms = () => quizPerms(SCENARIO, '424242424242424242');

/** Walks a chain to completion by always taking the first offered option, so
 * `answer.done` is true regardless of whether the picks were right. */
const completedAnswer = () => {
  const picks = SCENARIO.steps.map(() => 0);
  return replayAnswer(SCENARIO, picks);
};

describe('rules clips', () => {
  it('puts the SETUP clip on the public question message', () => {
    const { embeds, files } = buildQuizMessage(SCENARIO, 'en');

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(`${SCENARIO.id}-setup.gif`);
    expect(embeds[0]?.image?.url).toBe(`attachment://${SCENARIO.id}-setup.gif`);
  });

  it('NEVER puts the resolution clip on the public message', () => {
    const { embeds, files } = buildQuizMessage(SCENARIO, 'en');

    expect(files.map((f) => f.name)).not.toContain(`${SCENARIO.id}-resolution.gif`);
    expect(embeds[0]?.image?.url ?? '').not.toContain('resolution');
  });

  it('puts the SETUP clip on a chain that is still in progress', () => {
    const fresh = replayAnswer(SCENARIO, []);
    const { embeds, files } = buildChainMessage(SCENARIO, fresh, perms(), 'en');

    expect(fresh.done).toBe(false);
    // `/rules` opens straight into a chain with no public message to carry
    // the animation, so the chain itself has to show the play.
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(`${SCENARIO.id}-setup.gif`);
    expect(embeds[0]?.image?.url).toBe(`attachment://${SCENARIO.id}-setup.gif`);
  });

  it('withholds the resolution clip until this participant has finished', () => {
    // The gate is `answer.done`, so the case that matters is the LAST press
    // before the chain completes — not just a freshly-opened one.
    const partial = replayAnswer(
      SCENARIO,
      SCENARIO.steps.slice(0, -1).map(() => 0),
    );
    const { embeds, files } = buildChainMessage(SCENARIO, partial, perms(), 'en');

    expect(partial.done).toBe(false);
    expect(files.map((f) => f.name)).not.toContain(`${SCENARIO.id}-resolution.gif`);
    expect(embeds[0]?.image?.url ?? '').not.toContain('resolution');
  });

  it('attaches the resolution clip once the chain is done', () => {
    const done = completedAnswer();
    const { embeds, files } = buildChainMessage(SCENARIO, done, perms(), 'en');

    expect(done.done).toBe(true);
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe(`${SCENARIO.id}-resolution.gif`);
    expect(embeds[0]?.image?.url).toBe(`attachment://${SCENARIO.id}-resolution.gif`);
  });

  it('renders text-only when no clips are baked in, rather than failing', () => {
    delete process.env.RULES_GIF_DIR;

    const quiz = buildQuizMessage(SCENARIO, 'en');
    const chain = buildChainMessage(SCENARIO, completedAnswer(), perms(), 'en');

    expect(quiz.files).toHaveLength(0);
    expect(quiz.embeds[0]?.image).toBeUndefined();
    expect(quiz.embeds[0]?.fields?.length ?? 0).toBeGreaterThan(0);
    expect(chain.files).toHaveLength(0);
    expect(chain.embeds[0]?.image).toBeUndefined();

    // The in-progress chain reads a clip too now, so it needs the same guard.
    const midChain = buildChainMessage(SCENARIO, replayAnswer(SCENARIO, []), perms(), 'en');
    expect(midChain.files).toHaveLength(0);
    expect(midChain.embeds[0]?.image).toBeUndefined();
  });

  it('does not fail when a single scenario has no clip on disk', () => {
    const other = ALL_PACKAGES.flatMap((p) => p.scenarios).find((s) => s.id !== SCENARIO.id);
    if (other === undefined) throw new Error('content has only one scenario');

    const { embeds, files } = buildQuizMessage(other, 'en');

    expect(files).toHaveLength(0);
    expect(embeds[0]?.image).toBeUndefined();
  });
});
