import type { TeamGenerationApi } from '@sideline/domain';
import { Option } from 'effect';

/**
 * The five fields the team-generation Save button owns.
 *
 * The weights are numbers because they come from sliders, which cannot produce
 * an invalid value; the two counts are strings because they come from number
 * inputs, which can be cleared or typed into freely.
 */
export type GenerationWeightsFormValues = {
  weightElo: number;
  weightSize: number;
  weightGender: number;
  defaultTeamCount: string;
  maxIterations: string;
};

export const generationWeightsFormFrom = (
  config: TeamGenerationApi.GenerationConfigResponse,
): GenerationWeightsFormValues => ({
  weightElo: config.weightElo,
  weightSize: config.weightSize,
  weightGender: config.weightGender,
  defaultTeamCount: String(config.defaultTeamCount),
  maxIterations: String(config.maxIterations),
});

/** Per-field translation keys, so each error renders under its own input. */
export interface GenerationWeightsErrors {
  defaultTeamCount?: string;
  maxIterations?: string;
}

/**
 * Previously this card computed a single `isValid` boolean, used it to disable
 * Save, and displayed nothing. The button simply greyed out and never said
 * which of the two numbers was out of range — the same "you can edit it but
 * you cannot save it, and nothing tells you why" the team-settings cards had,
 * just expressed as a disabled control rather than a dead click.
 *
 * Bounds mirror the inputs' own `min`/`max` and the server's checks.
 */
export const validateGenerationWeights = (
  values: GenerationWeightsFormValues,
): GenerationWeightsErrors => {
  const errors: GenerationWeightsErrors = {};

  // A cleared input is `''`, and `Number.parseInt('')` is NaN — invalid, not 0.
  const teamCount = Number.parseInt(values.defaultTeamCount, 10);
  if (Number.isNaN(teamCount) || teamCount < 2 || teamCount > 20) {
    errors.defaultTeamCount = 'teamGenSettings_defaultTeamCountInvalid';
  }

  const iterations = Number.parseInt(values.maxIterations, 10);
  if (Number.isNaN(iterations) || iterations < 0 || iterations > 10000) {
    errors.maxIterations = 'teamGenSettings_maxIterationsInvalid';
  }

  return errors;
};

export const hasGenerationWeightsErrors = (errors: GenerationWeightsErrors): boolean =>
  Object.values(errors).some((v) => v !== undefined);

/** Assumes `validateGenerationWeights` returned no errors. */
export const generationWeightsRequestFrom = (values: GenerationWeightsFormValues) => ({
  weightElo: Option.some(values.weightElo),
  weightSize: Option.some(values.weightSize),
  weightGender: Option.some(values.weightGender),
  defaultTeamCount: Option.some(Number.parseInt(values.defaultTeamCount, 10)),
  maxIterations: Option.some(Number.parseInt(values.maxIterations, 10)),
});
