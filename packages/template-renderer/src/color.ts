export const DISCORD_BLURPLE = 0x5865f2;
const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

/** Validates hex color (`^#[0-9a-fA-F]{6}$`), parses to integer, falls back to DISCORD_BLURPLE. */
export const sanitizeHexColor = (hex: string | null | undefined): number => {
  if (!hex || !HEX_REGEX.test(hex)) return DISCORD_BLURPLE;
  return Number.parseInt(hex.slice(1), 16);
};
