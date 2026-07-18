import type { Carpool, Discord as DomainDiscord, TeamMember } from '@sideline/domain';
import { CarpoolRpcModels } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildCarpoolEmbed } from '~/rest/carpool/buildCarpoolEmbed.js';

const CARPOOL_ID = '00000000-0000-0000-0000-000000000001' as Carpool.CarpoolId;
const CHANNEL_ID = '111111111111111111' as DomainDiscord.Snowflake;
const CAR_ID_A = '00000000-0000-0000-0000-000000000010' as Carpool.CarpoolCarId;
const CAR_ID_B = '00000000-0000-0000-0000-000000000011' as Carpool.CarpoolCarId;
const MEMBER_ID_1 = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const MEMBER_ID_2 = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const MEMBER_ID_3 = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;

const makeMember = (
  team_member_id: TeamMember.TeamMemberId,
  name: string,
): CarpoolRpcModels.MemberDisplay =>
  new CarpoolRpcModels.MemberDisplay({
    team_member_id,
    discord_id: Option.none(),
    name: Option.some(name),
    nickname: Option.none(),
    display_name: Option.none(),
    username: Option.none(),
  });

const makeCar = (
  car_id: Carpool.CarpoolCarId,
  owner: CarpoolRpcModels.MemberDisplay,
  capacity: number,
  passengers: CarpoolRpcModels.MemberDisplay[] = [],
): CarpoolRpcModels.CarpoolCarView =>
  new CarpoolRpcModels.CarpoolCarView({
    car_id,
    thread_id: Option.none(),
    capacity,
    note: Option.none(),
    owner,
    passengers,
  });

const makeView = (cars: CarpoolRpcModels.CarpoolCarView[]): CarpoolRpcModels.CarpoolView =>
  new CarpoolRpcModels.CarpoolView({
    carpool_id: CARPOOL_ID,
    language: 'en',
    discord_channel_id: CHANNEL_ID,
    discord_message_id: Option.none(),
    event_id: Option.none(),
    cars,
  });

type BtnLike = { style?: number; disabled?: boolean; custom_id?: string };

/** Finds the leave-mine button in an action row by custom_id prefix. */
const findLeaveMineButton = (row: { components: ReadonlyArray<unknown> }) =>
  (row.components as ReadonlyArray<BtnLike>).find((btn) =>
    btn.custom_id?.startsWith('carpool-leave-mine:'),
  );

describe('buildCarpoolEmbed', () => {
  describe('row 1 — add row always has exactly 2 buttons', () => {
    it('board with cars: row 1 has Add button and Leave-my-car button', () => {
      const owner = makeMember(MEMBER_ID_1, 'Alice');
      const car = makeCar(CAR_ID_A, owner, 4);
      const view = makeView([car]);

      const { components } = buildCarpoolEmbed(view);

      const row1 = components[0];
      expect(row1.components).toHaveLength(2);

      const addBtn = (row1.components as ReadonlyArray<BtnLike>).find((btn) =>
        btn.custom_id?.startsWith('carpool-add:'),
      );
      expect(addBtn).toBeDefined();
      expect(addBtn?.custom_id).toBe(`carpool-add:${CARPOOL_ID}`);
      expect(addBtn?.style).toBe(1);

      const leaveBtn = findLeaveMineButton(row1);
      expect(leaveBtn).toBeDefined();
      expect(leaveBtn?.custom_id).toBe(`carpool-leave-mine:${CARPOOL_ID}`);
      expect(leaveBtn?.style).toBe(4);
    });

    it('empty board: row 1 still has exactly 2 buttons', () => {
      const view = makeView([]);

      const { components } = buildCarpoolEmbed(view);

      const row1 = components[0];
      expect(row1.components).toHaveLength(2);
    });
  });

  describe('Leave-my-car button disabled state', () => {
    it('is ENABLED (disabled not true) when there are cars', () => {
      const owner = makeMember(MEMBER_ID_1, 'Alice');
      const car = makeCar(CAR_ID_A, owner, 4);
      const view = makeView([car]);

      const { components } = buildCarpoolEmbed(view);

      const leaveBtn = findLeaveMineButton(components[0]);
      expect(leaveBtn).toBeDefined();
      expect(leaveBtn?.disabled).not.toBe(true);
    });

    it('is DISABLED when there are no cars', () => {
      const view = makeView([]);

      const { components } = buildCarpoolEmbed(view);

      const leaveBtn = findLeaveMineButton(components[0]);
      expect(leaveBtn).toBeDefined();
      expect(leaveBtn?.disabled).toBe(true);
    });

    it('custom_id encodes the carpool_id correctly for leave-mine', () => {
      const owner = makeMember(MEMBER_ID_1, 'Alice');
      const car = makeCar(CAR_ID_A, owner, 4);
      const view = makeView([car]);

      const { components } = buildCarpoolEmbed(view);

      const leaveBtn = findLeaveMineButton(components[0]);
      expect(leaveBtn?.custom_id).toBe(`carpool-leave-mine:${CARPOOL_ID}`);
    });
  });

  describe('reserve buttons in subsequent rows', () => {
    it('board with one car has a carpool-reserve button in row 2', () => {
      const owner = makeMember(MEMBER_ID_1, 'Alice');
      const car = makeCar(CAR_ID_A, owner, 4);
      const view = makeView([car]);

      const { components } = buildCarpoolEmbed(view);

      expect(components.length).toBeGreaterThanOrEqual(2);
      const row2 = components[1];
      const reserveBtn = (row2.components as ReadonlyArray<BtnLike>).find((btn) =>
        btn.custom_id?.startsWith('carpool-reserve:'),
      );
      expect(reserveBtn).toBeDefined();
      expect(reserveBtn?.custom_id).toBe(`carpool-reserve:${CAR_ID_A}`);
    });

    it('available car reserve button has style 3 (Success/green) and is not disabled', () => {
      const owner = makeMember(MEMBER_ID_1, 'Alice');
      // capacity 4, no passengers → 3 free seats
      const car = makeCar(CAR_ID_A, owner, 4);
      const view = makeView([car]);

      const { components } = buildCarpoolEmbed(view);

      const reserveBtn = (
        components[1].components as ReadonlyArray<{
          style?: number;
          disabled?: boolean;
          custom_id?: string;
        }>
      ).find((btn) => btn.custom_id?.startsWith('carpool-reserve:'));
      expect(reserveBtn?.style).toBe(3);
      expect(reserveBtn?.disabled).not.toBe(true);
    });

    it('full car reserve button has style 2 (Secondary) and is disabled', () => {
      const owner = makeMember(MEMBER_ID_1, 'Alice');
      const passenger = makeMember(MEMBER_ID_2, 'Bob');
      // capacity 2: owner + 1 passenger = full
      const car = makeCar(CAR_ID_A, owner, 2, [passenger]);
      const view = makeView([car]);

      const { components } = buildCarpoolEmbed(view);

      const reserveBtn = (
        components[1].components as ReadonlyArray<{
          style?: number;
          disabled?: boolean;
          custom_id?: string;
        }>
      ).find((btn) => btn.custom_id?.startsWith('carpool-reserve:'));
      expect(reserveBtn?.style).toBe(2);
      expect(reserveBtn?.disabled).toBe(true);
    });

    it('board with two cars places both reserve buttons (across rows)', () => {
      const owner1 = makeMember(MEMBER_ID_1, 'Alice');
      const owner2 = makeMember(MEMBER_ID_2, 'Bob');
      const car1 = makeCar(CAR_ID_A, owner1, 4);
      const car2 = makeCar(CAR_ID_B, owner2, 3);
      const view = makeView([car1, car2]);

      const { components } = buildCarpoolEmbed(view);

      // Both cars fit in the same reserve row (4 per row)
      const allButtons = components.slice(1).flatMap((row) => row.components as any[]);
      const reserveIds = allButtons
        .filter((btn) => btn.custom_id?.startsWith('carpool-reserve:'))
        .map((btn) => btn.custom_id);

      expect(reserveIds).toContain(`carpool-reserve:${CAR_ID_A}`);
      expect(reserveIds).toContain(`carpool-reserve:${CAR_ID_B}`);
    });
  });

  describe('empty board', () => {
    it('has only 1 component row (the add row) when there are no cars', () => {
      const view = makeView([]);

      const { components } = buildCarpoolEmbed(view);

      expect(components).toHaveLength(1);
    });
  });

  describe('board with multiple passengers', () => {
    it('Leave-my-car is enabled even when passengers are present', () => {
      const owner = makeMember(MEMBER_ID_1, 'Alice');
      const passenger1 = makeMember(MEMBER_ID_2, 'Bob');
      const passenger2 = makeMember(MEMBER_ID_3, 'Carol');
      const car = makeCar(CAR_ID_A, owner, 5, [passenger1, passenger2]);
      const view = makeView([car]);

      const { components } = buildCarpoolEmbed(view);

      const leaveBtn = findLeaveMineButton(components[0]);
      expect(leaveBtn?.disabled).not.toBe(true);
    });
  });
});
