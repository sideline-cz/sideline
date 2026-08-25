/**
 * Content types for the WFDF Rules of Ultimate trainer.
 *
 * These shapes are derived from the measured content (109 scenarios, 367
 * steps, 1182 options — see `packages/rules/AGENTS.md`), not designed
 * up-front. There is no runtime `Schema` decode: content is repo-versioned,
 * reviewed in PRs, and validated by guards in CI instead (see the Phase 0
 * plan, decision D2).
 */

export type Lang = 'en' | 'cs';

export type Localized<T> = Readonly<Record<Lang, T>>;

export type Level = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

declare const ScenarioIdBrand: unique symbol;

/**
 * Branded scenario id. There is no constructor / validated `make` — content
 * is trusted, reviewed data (see the module doc above), so the brand exists
 * purely to stop engine state (`Record<ScenarioId, Answer>`,
 * `exam.qs: ScenarioId[]`, …) from ever being keyed by a plain, unchecked
 * `string` (see the Phase 0 plan, decision D8).
 */
export type ScenarioId = string & { readonly [ScenarioIdBrand]: 'ScenarioId' };

export type Team = 'off' | 'def';

/** `[t, x, y]` — a single animation keyframe. */
export type Keyframe = readonly [t: number, x: number, y: number];

export type Actor = {
  readonly id: string;
  readonly team: Team;
  readonly label: string;
  readonly kf: readonly Keyframe[];
  /** Exactly one actor per scenario carries `you: true` (measured 109/469 actors). */
  readonly you?: true;
};

export type Disc = {
  readonly kf: readonly Keyframe[];
  /** Present on 34/109 scenarios — only when the disc comes to rest mid-animation. */
  readonly downAt?: number;
};

export type FxBubbleStyle = 'count' | 'call';

export type FxMarkKind = 'x' | 'target' | 'zone' | 'dot';

type FxBase = {
  readonly t: number;
};

export type FxBubble = FxBase & {
  readonly type: 'bubble';
  readonly dur: number;
  readonly actor: string;
  readonly text: Localized<string>;
  readonly style: FxBubbleStyle;
};

export type FxFlash = FxBase & {
  readonly type: 'flash';
  readonly x: number;
  readonly y: number;
};

export type FxArrow = FxBase & {
  readonly type: 'arrow';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
};

export type FxMark = FxBase & {
  readonly type: 'mark';
  readonly kind: FxMarkKind;
  readonly x: number;
  readonly y: number;
  readonly label: Localized<string>;
  /** Present on 5/425 fx total — only when the label would otherwise collide with the mark. */
  readonly labelAbove?: boolean;
  /**
   * Radius. Only meaningful for `kind: 'zone'` — the `x`, `target` and `dot`
   * branches all draw at hardcoded radii and never read it.
   *
   * It stays optional on the type because a static type cannot express a
   * value-dependent constraint, but the G13 guard narrows it further: `r` is
   * allowed ONLY on `kind: 'zone'`. That guard found and removed 57 dead `r`
   * values here; don't author new ones on other kinds, they render nothing.
   */
  readonly r?: number;
};

/** Discriminated on `type`. `buildFx` in the source app only ever branched on
 * these four — a `zone`-typed fx (not `mark`/`kind: 'zone'`) rendered nothing
 * and the 6 that existed were deleted in Phase 0 (decision D6a). */
export type Fx = FxBubble | FxFlash | FxArrow | FxMark;

export type Option = {
  readonly t: Localized<string>;
  /** `true` marks the single correct option in a step; absent (never `false`) otherwise. */
  readonly ok?: true;
  readonly why: Localized<string>;
};

export type Step = {
  readonly k: string;
  readonly q: Localized<string>;
  readonly rules: readonly string[];
  readonly opts: readonly Option[];
};

export type Scenario = {
  readonly id: ScenarioId;
  readonly level: Level;
  readonly topic: Localized<string>;
  readonly title: Localized<string>;
  readonly roleTeam: Team;
  readonly role: Localized<string>;
  /** `[x, y, width, height]` viewBox for the field SVG. */
  readonly view: readonly [number, number, number, number];
  readonly dur: number;
  readonly qAt: number;
  readonly actors: readonly Actor[];
  readonly disc: Disc;
  readonly fx: readonly Fx[];
  readonly situation: Localized<string>;
  readonly question: Localized<string>;
  readonly explain: Localized<string>;
  /** Present on 100/109 scenarios. */
  readonly note?: Localized<string>;
  readonly rules: readonly string[];
  /** Signal ids — numeric keys into `SIGNALS` (see `reference.ts`). Present on 100/109 scenarios. */
  readonly signals?: readonly number[];
  readonly steps: readonly Step[];
};

export type RulesPackage = {
  readonly level: Level;
  /** English-only in the source content (e.g. `"Level 1 · The pull"`); see `LEVEL_META` in `constants.ts` for the bilingual, hand-maintained equivalent. */
  readonly name: string;
  readonly scenarios: readonly Scenario[];
};

/** A rule quote, keyed by rule number (e.g. `'7.12'`) — see `RULES` in `reference.ts`. */
export type RuleEntry = Localized<string>;

/** A hand-signal description, keyed by signal id (e.g. `'7'`) — see `SIGNALS` in `reference.ts`. */
export type SignalEntry = Localized<string>;

/**
 * The cheat-sheet tables — see `CHEAT_SHEET` in `reference.ts`.
 *
 * Each table is localised as a WHOLE (`Localized<readonly string[][]>`) rather
 * than cell by cell, because a row's cells are one authored unit: the Czech
 * rendering of "Accepted breach by the defence / “Stalling 1” / 9.5.1" has to
 * line up as a row, and a per-cell shape invites the two languages drifting
 * out of alignment. The guard asserts both languages have identical row and
 * column counts.
 */
export type CheatSheet = {
  /** Column headers for the stall-count table (3 columns). */
  readonly cheatStallH: Localized<readonly string[]>;
  /** Stall-count restart table: [after what, resumes at, citation]. */
  readonly cheatStallRows: Localized<readonly (readonly string[])[]>;
  /** Who may make which call: [call, who]. */
  readonly cheatWhoRows: Localized<readonly (readonly string[])[]>;
  /** "Golden rules": [headline, explanation]. */
  readonly cheatGoldRows: Localized<readonly (readonly string[])[]>;
};
