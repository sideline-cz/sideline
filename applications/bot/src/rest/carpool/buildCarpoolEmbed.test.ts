import type { Carpool, Discord, TeamMember } from '@sideline/domain';
import { CarpoolRpcModels } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildCarpoolEmbed } from '~/rest/carpool/buildCarpoolEmbed.js';

const locale = 'en' as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CARPOOL_ID = 'cp-001' as Carpool.CarpoolId;
const CAR_ID_1 = 'car-001' as Carpool.CarpoolCarId;
const CAR_ID_2 = 'car-002' as Carpool.CarpoolCarId;
const BOARD_CHANNEL_ID = '700000000000000001' as Discord.Snowflake;
const BOARD_MESSAGE_ID = '700000000000000002' as Discord.Snowflake;

const makeMember = (
  teamMemberId: string,
  name: string | null = 'Alice',
  discordId: string | null = '100000000000000001',
): CarpoolRpcModels.MemberDisplay =>
  new CarpoolRpcModels.MemberDisplay({
    team_member_id: teamMemberId as TeamMember.TeamMemberId,
    discord_id: discordId != null ? Option.some(discordId as Discord.Snowflake) : Option.none(),
    name: name != null ? Option.some(name) : Option.none(),
    nickname: Option.none(),
    display_name: Option.none(),
    username: Option.none(),
  });

const makeCar = (
  carId: Carpool.CarpoolCarId,
  capacity: number,
  owner: CarpoolRpcModels.MemberDisplay,
  passengers: CarpoolRpcModels.MemberDisplay[] = [],
  note: string | null = null,
  threadId: string | null = null,
): CarpoolRpcModels.CarpoolCarView =>
  new CarpoolRpcModels.CarpoolCarView({
    car_id: carId,
    thread_id: threadId != null ? Option.some(threadId as any) : Option.none(),
    capacity,
    note: note != null ? Option.some(note) : Option.none(),
    owner,
    passengers,
  });

const emptyView = new CarpoolRpcModels.CarpoolView({
  carpool_id: CARPOOL_ID,
  discord_channel_id: BOARD_CHANNEL_ID,
  discord_message_id: Option.some(BOARD_MESSAGE_ID),
  event_id: Option.none(),
  cars: [],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCarpoolEmbed', () => {
  it('empty carpool — only add button present, no car fields', () => {
    const { embeds, components } = buildCarpoolEmbed(emptyView, locale);

    expect(embeds).toHaveLength(1);
    // No car fields in the embed
    const fields = embeds[0].fields ?? [];
    expect(fields.every((f) => !f.value.includes('car-'))).toBe(true);

    // Components should include a carpool-add button and nothing else
    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.some((id) => id.startsWith('carpool-add'))).toBe(true);
    // No reserve buttons for an empty carpool
    expect(allCustomIds.every((id) => !id.startsWith('carpool-reserve:'))).toBe(true);
  });

  it('one car with passengers — field shows occupied/capacity, owner with crown first, then passengers', () => {
    const owner = makeMember('tm-owner', 'BobDriver', '200000000000000001');
    const passenger = makeMember('tm-pass', 'AlicePassenger', '200000000000000002');
    const car = makeCar(CAR_ID_1, 4, owner, [passenger]);
    const view = new CarpoolRpcModels.CarpoolView({
      carpool_id: CARPOOL_ID,
      discord_channel_id: BOARD_CHANNEL_ID,
      discord_message_id: Option.some(BOARD_MESSAGE_ID),
      event_id: Option.none(),
      cars: [car],
    });

    const { embeds, components } = buildCarpoolEmbed(view, locale);

    expect(embeds).toHaveLength(1);
    const fields = embeds[0].fields ?? [];
    // At least one field should mention the car
    const carField = fields.find((f) => f.value.includes('BobDriver'));
    expect(carField).toBeDefined();
    // Owner should appear before passengers (crown marker 👑)
    expect(carField?.value).toContain('👑');
    // Occupied/capacity notation
    expect(JSON.stringify(embeds)).toMatch(/2.*4|occupied/i);

    // Reserve button for CAR_ID_1
    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);
    expect(allCustomIds.some((id) => id === `carpool-reserve:${CAR_ID_1}`)).toBe(true);
  });

  it('full car — reserve button is disabled', () => {
    const owner = makeMember('tm-owner-full', 'FullOwner');
    // capacity 2, owner + 1 passenger = full
    const passenger = makeMember('tm-pass-full', 'FullPass');
    const fullCar = makeCar(CAR_ID_1, 2, owner, [passenger]);
    const view = new CarpoolRpcModels.CarpoolView({
      carpool_id: CARPOOL_ID,
      discord_channel_id: BOARD_CHANNEL_ID,
      discord_message_id: Option.some(BOARD_MESSAGE_ID),
      event_id: Option.none(),
      cars: [fullCar],
    });

    const { components } = buildCarpoolEmbed(view, locale);

    const allButtons = components.flatMap((row) => (row as any).components ?? []) as Array<{
      custom_id?: string;
      disabled?: boolean;
    }>;
    const reserveBtn = allButtons.find((b) => b.custom_id === `carpool-reserve:${CAR_ID_1}`);
    expect(reserveBtn).toBeDefined();
    expect(reserveBtn?.disabled).toBe(true);
  });

  it('member with all null name fields — renders "Unknown" fallback, no throw', () => {
    const nullNameOwner = new CarpoolRpcModels.MemberDisplay({
      team_member_id: 'tm-null-name' as any,
      discord_id: Option.some('300000000000000001' as any),
      name: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
      username: Option.none(),
    });
    const car = makeCar(CAR_ID_1, 4, nullNameOwner);
    const view = new CarpoolRpcModels.CarpoolView({
      carpool_id: CARPOOL_ID,
      discord_channel_id: BOARD_CHANNEL_ID,
      discord_message_id: Option.some(BOARD_MESSAGE_ID),
      event_id: Option.none(),
      cars: [car],
    });

    // Should not throw
    expect(() => buildCarpoolEmbed(view, locale)).not.toThrow();

    const { embeds } = buildCarpoolEmbed(view, locale);
    expect(embeds).toHaveLength(1);
    // formatName renders 'Unknown' when all name fields are None (no mention appended)
    const embedJson = JSON.stringify(embeds);
    expect(embedJson).toContain('Unknown');
    expect(embedJson).not.toContain('<@300000000000000001>');
  });

  it('cars beyond display cap (~10) — extra cars not rendered', () => {
    // Create 12 cars, each with a unique owner
    const cars = Array.from({ length: 12 }, (_, i) => {
      const carId = `car-over-${i}` as Carpool.CarpoolCarId;
      const owner = makeMember(
        `tm-over-${i}`,
        `Driver${i}`,
        `400000000000000${String(i).padStart(3, '0')}`,
      );
      return makeCar(carId, 4, owner);
    });
    const view = new CarpoolRpcModels.CarpoolView({
      carpool_id: CARPOOL_ID,
      discord_channel_id: BOARD_CHANNEL_ID,
      discord_message_id: Option.some(BOARD_MESSAGE_ID),
      event_id: Option.none(),
      cars,
    });

    const { embeds, components } = buildCarpoolEmbed(view, locale);

    // Should have at most ~10 cars rendered (not 12)
    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);
    const reserveButtons = allCustomIds.filter((id) => id.startsWith('carpool-reserve:'));
    expect(reserveButtons.length).toBeLessThanOrEqual(10);

    // Embed fields should not exceed ~10 car entries either
    const fields = embeds[0].fields ?? [];
    // The fields count for cars should be bounded
    // Each car gets a field; cap is ~10
    const carFieldCount = fields.filter((f) => f.value.includes('👑')).length;
    expect(carFieldCount).toBeLessThanOrEqual(10);
  });

  it('free seats shown as italic placeholders when car not full', () => {
    const owner = makeMember('tm-free-owner', 'CarOwner');
    // capacity 4, only owner — 3 free seats
    const car = makeCar(CAR_ID_1, 4, owner);
    const view = new CarpoolRpcModels.CarpoolView({
      carpool_id: CARPOOL_ID,
      discord_channel_id: BOARD_CHANNEL_ID,
      discord_message_id: Option.some(BOARD_MESSAGE_ID),
      event_id: Option.none(),
      cars: [car],
    });

    const { embeds } = buildCarpoolEmbed(view, locale);
    const fields = embeds[0].fields ?? [];
    const carFieldJson = JSON.stringify(fields);
    // Free seats rendered as italic (markdown *...*) or similar placeholder
    // At least one italic marker should appear for an empty slot
    expect(carFieldJson).toMatch(/\*[^*]+\*|_[^_]+_/);
  });

  it('carpool-add button always present regardless of car count', () => {
    const owner = makeMember('tm-add-btn', 'AddBtnOwner');
    const car = makeCar(CAR_ID_1, 4, owner);
    const viewWithCar = new CarpoolRpcModels.CarpoolView({
      carpool_id: CARPOOL_ID,
      discord_channel_id: BOARD_CHANNEL_ID,
      discord_message_id: Option.some(BOARD_MESSAGE_ID),
      event_id: Option.none(),
      cars: [car],
    });

    const { components: componentsWithCar } = buildCarpoolEmbed(viewWithCar, locale);
    const { components: componentsEmpty } = buildCarpoolEmbed(emptyView, locale);

    const hasAddWithCar = componentsWithCar
      .flatMap((row) => (row as any).components ?? [])
      .some((c: any) => (c.custom_id as string).startsWith('carpool-add'));

    const hasAddEmpty = componentsEmpty
      .flatMap((row) => (row as any).components ?? [])
      .some((c: any) => (c.custom_id as string).startsWith('carpool-add'));

    expect(hasAddWithCar).toBe(true);
    expect(hasAddEmpty).toBe(true);
  });

  it('multiple cars — each gets its own reserve button with correct car_id', () => {
    const owner1 = makeMember('tm-multi-1', 'Driver1');
    const owner2 = makeMember('tm-multi-2', 'Driver2');
    const car1 = makeCar(CAR_ID_1, 4, owner1);
    const car2 = makeCar(CAR_ID_2, 3, owner2);
    const view = new CarpoolRpcModels.CarpoolView({
      carpool_id: CARPOOL_ID,
      discord_channel_id: BOARD_CHANNEL_ID,
      discord_message_id: Option.some(BOARD_MESSAGE_ID),
      event_id: Option.none(),
      cars: [car1, car2],
    });

    const { components } = buildCarpoolEmbed(view, locale);
    const allCustomIds = components
      .flatMap((row) => (row as any).components ?? [])
      .map((c: any) => c.custom_id as string);

    expect(allCustomIds.some((id) => id === `carpool-reserve:${CAR_ID_1}`)).toBe(true);
    expect(allCustomIds.some((id) => id === `carpool-reserve:${CAR_ID_2}`)).toBe(true);
  });
});
