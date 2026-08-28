/**
 * The **ephemeral** half of the Discord rules quiz: one participant's own
 * progress through a scenario's chain.
 *
 * Every reveal decision here comes from `chainView` — which steps are
 * visible, whether a verdict may be shown, and whether a step's key label
 * (`step.k`) may be shown. None of that logic is restated in this file. The
 * plan is explicit about why (`docs/plans/rules-trainer.md`, "the spoiler
 * gate still has to hold, differently"): in Discord the failure is not a
 * demo playing too far, it is a later step's key label or a wrong option's
 * `why` arriving in the same message. `chainView` already computes exactly
 * that, and re-deriving it here is how the two surfaces would drift.
 *
 * A locked step's key label is a spoiler in its own right — "Where it
 * restarts" implies there *is* a restart — which is why the locked branch
 * below renders a placeholder and never touches `step.k`.
 */

import * as m from '@sideline/i18n/messages';
import type { Answer, ChainEntry, Scenario } from '@sideline/rules';
import { chainView, text } from '@sideline/rules';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';
import { truncate } from './buildQuizMessage.js';
import { clipAttachment } from './clips.js';
import { encodeStepId } from './quizState.js';

const COLOR_IN_PROGRESS = 0x5865f2; // blurple
const COLOR_CORRECT = 0x2ecc71; // emerald
const COLOR_WRONG = 0xe74c3c; // red

const EMBED_TITLE_MAX = 256;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const BUTTON_LABEL_MAX = 80;

/** `A`/`B`/`C`/`D`, matching web's option letters. Content never authors
 * more than four options per step (`packages/rules/AGENTS.md`). */
const LETTERS = ['A', 'B', 'C', 'D'] as const;

const KEY_LABEL: Record<string, (locale: Locale) => string> = {
  what: (locale) => m.rules_kwhat({}, { locale }),
  where: (locale) => m.rules_kwhere({}, { locale }),
  who: (locale) => m.rules_kwho({}, { locale }),
  how: (locale) => m.rules_khow({}, { locale }),
  flow: (locale) => m.rules_kflow({}, { locale }),
  stall: (locale) => m.rules_kstall({}, { locale }),
};

const stepHeading = (
  scenario: Scenario,
  entry: ChainEntry,
  locale: Locale,
  marker: string,
): string => {
  const base = `${marker} ${m.rules_stepWord({}, { locale })} ${entry.index + 1}/${scenario.steps.length}`;
  if (!entry.showKeyLabel) return truncate(base, FIELD_NAME_MAX);
  const key = scenario.steps[entry.index]?.k;
  const label = key === undefined ? undefined : KEY_LABEL[key]?.(locale);
  return truncate(label === undefined ? base : `${base} · ${label}`, FIELD_NAME_MAX);
};

/** The body of an already-answered step: what they picked and why, plus the
 * correct option when they got it wrong. Only ever called when
 * `entry.showVerdict` is true. */
const answeredValue = (
  scenario: Scenario,
  entry: ChainEntry,
  answer: Answer,
  locale: Locale,
): string => {
  const step = scenario.steps[entry.index];
  const rec = answer.steps[entry.index];
  if (!step || !rec || rec.pick === null) return '—';
  const picked = step.opts[rec.pick];
  if (!picked) return '—';

  const lines = [`${rec.ok ? '✅' : '❌'} **${text(picked.t, locale)}**`, text(picked.why, locale)];

  if (!rec.ok) {
    const correct = step.opts.find((o) => o.ok === true);
    if (correct) {
      lines.push(`✅ **${text(correct.t, locale)}** — ${text(correct.why, locale)}`);
    }
  }
  return truncate(lines.join('\n'), FIELD_VALUE_MAX);
};

/**
 * One participant's ephemeral view of a chain.
 *
 * When the chain is not finished, the live step's options render as
 * buttons whose `custom_id` carries the picks so far plus the one that
 * button would add — so pressing it is the entire state transition, and
 * nothing is stored between presses (see `quizState.ts`).
 */
export const buildChainMessage = (
  scenario: Scenario,
  answer: Answer,
  perms: readonly (readonly number[])[],
  locale: Locale,
  /** Appended as a final field once the chain is done — whether the attempt
   * reached the server. Never guessed: the caller passes it only after the
   * submit has actually resolved, so a failed save is never shown as saved. */
  saveNote?: string,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
  files: ReadonlyArray<File>;
} => {
  const entries = chainView(scenario, answer, 'learn', perms);
  const picksSoFar = answer.steps.flatMap((s) => (s.pick === null ? [] : [s.pick]));

  const fields: Discord.RichEmbedField[] = [];
  let liveEntry: ChainEntry | undefined;

  for (const entry of entries) {
    if (entry.state === 'hidden') continue;
    const step = scenario.steps[entry.index];
    if (!step) continue;

    if (entry.state === 'locked') {
      fields.push({
        name: stepHeading(scenario, entry, locale, '🔒'),
        value: m.rules_stepLocked({}, { locale }),
      });
      continue;
    }

    if (entry.state === 'answered' && entry.showVerdict) {
      fields.push({
        name: stepHeading(
          scenario,
          entry,
          locale,
          answer.steps[entry.index]?.ok === true ? '✅' : '❌',
        ),
        value: answeredValue(scenario, entry, answer, locale),
      });
      continue;
    }

    // The live step: its question, with its options rendered as buttons below.
    liveEntry = entry;
    fields.push({
      name: stepHeading(scenario, entry, locale, '▶️'),
      value: truncate(text(step.q, locale), FIELD_VALUE_MAX),
    });
  }

  if (answer.done) {
    const okCount = answer.steps.filter((s) => s.ok).length;
    const verdict = answer.ok
      ? `${m.rules_correct({}, { locale })} ${m.rules_chainDone({}, { locale })}`
      : `${m.rules_incorrect({}, { locale })} ${okCount}/${answer.steps.length} ${m.rules_chainSteps({}, { locale })}`;
    fields.push({
      name: verdict,
      value: truncate(text(scenario.explain, locale), FIELD_VALUE_MAX),
    });
    if (scenario.note) {
      fields.push({
        name: m.rules_alsoNote({}, { locale }),
        value: truncate(text(scenario.note, locale), FIELD_VALUE_MAX),
      });
    }
    if (scenario.rules.length > 0) {
      fields.push({
        name: m.rules_refs({}, { locale }),
        value: truncate(scenario.rules.map((r) => `§ ${r}`).join(' · '), FIELD_VALUE_MAX),
      });
    }
    if (saveNote !== undefined) {
      fields.push({ name: '​', value: truncate(saveNote, FIELD_VALUE_MAX) });
    }
  }

  // The resolution clip is gated on `answer.done` and nothing else. This
  // message is ephemeral and `answer` is this participant's own replayed
  // state, so "done" here means *this* user finished — never that someone
  // else did. Mid-chain the animation stays where the public message left it,
  // which is the point of encoding two clips rather than one.
  const clip = answer.done ? clipAttachment(scenario.id, 'resolution') : undefined;

  const embed: Discord.RichEmbed = {
    title: truncate(text(scenario.title, locale), EMBED_TITLE_MAX),
    color: answer.done ? (answer.ok ? COLOR_CORRECT : COLOR_WRONG) : COLOR_IN_PROGRESS,
    fields,
    ...(clip === undefined ? {} : { image: { url: clip.url } }),
  };

  const liveStep = liveEntry === undefined ? undefined : scenario.steps[liveEntry.index];
  const components: Discord.ActionRowComponentForMessageRequest[] =
    liveEntry === undefined || liveStep === undefined
      ? []
      : [
          UI.row(
            liveEntry.order.flatMap((originalIndex, displayPosition) => {
              const opt = liveStep.opts[originalIndex];
              if (!opt) return [];
              const letter = LETTERS[displayPosition] ?? String(displayPosition + 1);
              return [
                UI.button({
                  style: Discord.ButtonStyleTypes.SECONDARY,
                  label: truncate(`${letter} · ${text(opt.t, locale)}`, BUTTON_LABEL_MAX),
                  custom_id: encodeStepId(scenario.id, [...picksSoFar, originalIndex]),
                }),
              ];
            }),
          ),
        ];

  return { embeds: [embed], components, files: clip === undefined ? [] : [clip.file] };
};
