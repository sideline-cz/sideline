export const DEFAULT_RATING = 1200;
export const CALIBRATION_GAMES = 10;
export const K_CALIBRATION = 40;
export const K_ESTABLISHED = 20;

/** The outcome of a game from a neutral perspective: 'teamA' means team A won. */
export type GameOutcome = 'teamA' | 'teamB' | 'draw';

export interface PlayerRatingInput {
  readonly teamMemberId: string;
  readonly rating: number;
  readonly gamesPlayed: number;
}

export interface PlayerRatingUpdate {
  readonly teamMemberId: string;
  readonly oldRating: number;
  readonly newRating: number;
  readonly delta: number;
  readonly kFactor: number;
}

export interface TeamGameInput {
  readonly teamA: ReadonlyArray<PlayerRatingInput>;
  readonly teamB: ReadonlyArray<PlayerRatingInput>;
  readonly outcome: GameOutcome;
}

/** Expected score for player A against player B using the standard Elo formula. */
export const expectedScore = (ratingA: number, ratingB: number): number =>
  1 / (1 + 10 ** ((ratingB - ratingA) / 400));

/** Returns the K-factor for a player based on how many games they have played. */
export const kFactor = (gamesPlayed: number): number =>
  gamesPlayed < CALIBRATION_GAMES ? K_CALIBRATION : K_ESTABLISHED;

/**
 * Compute per-player rating updates for a team game.
 *
 * Each player's K-factor is determined individually and ratings are rounded to
 * the nearest integer. Per-player K-factor + integer rounding means exact
 * zero-sum is NOT guaranteed; this is intentional (same as chess Elo).
 */
export const computeTeamGameUpdate = (
  input: TeamGameInput,
): { teamA: ReadonlyArray<PlayerRatingUpdate>; teamB: ReadonlyArray<PlayerRatingUpdate> } => {
  if (input.teamA.length === 0 || input.teamB.length === 0) {
    return { teamA: [], teamB: [] };
  }

  const avgA = input.teamA.reduce((sum, p) => sum + p.rating, 0) / input.teamA.length;
  const avgB = input.teamB.reduce((sum, p) => sum + p.rating, 0) / input.teamB.length;

  const expA = expectedScore(avgA, avgB);
  const expB = 1 - expA;

  const [actualA, actualB]: [number, number] =
    input.outcome === 'teamA' ? [1, 0] : input.outcome === 'teamB' ? [0, 1] : [0.5, 0.5];

  const mapUpdates =
    (actual: number, exp: number) =>
    (player: PlayerRatingInput): PlayerRatingUpdate => {
      const k = kFactor(player.gamesPlayed);
      const newRating = Math.round(player.rating + k * (actual - exp));
      return {
        teamMemberId: player.teamMemberId,
        oldRating: player.rating,
        newRating,
        delta: newRating - player.rating,
        kFactor: k,
      };
    };

  return {
    teamA: input.teamA.map(mapUpdates(actualA, expA)),
    teamB: input.teamB.map(mapUpdates(actualB, expB)),
  };
};
