import type { CarpoolRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';
import { formatName } from '~/rest/utils.js';

/** Maximum number of cars to render to stay within Discord's 5-row × 5-button limit */
const MAX_CARS_DISPLAYED = 10;

/** Blurple — default/partial color */
const COLOR_BLURPLE = 0x5865f2;
/** Green — all cars full */
const COLOR_GREEN = 0x57f287;
/** Orange — no cars yet */
const COLOR_ORANGE = 0xe67e22;

const renderMember = (member: CarpoolRpcModels.MemberDisplay): string =>
  formatName({
    name: member.name,
    nickname: member.nickname,
    display_name: member.display_name,
    username: member.username,
  });

const buildCarField = (
  car: CarpoolRpcModels.CarpoolCarView,
  carIndex: number,
  locale: Locale,
): Discord.RichEmbedField => {
  const occupied = 1 + car.passengers.length;
  const isFull = occupied >= car.capacity;
  const ownerName = renderMember(car.owner);

  const headerText = isFull
    ? m.bot_carpool_car_header_full({ n: carIndex, owner: ownerName }, { locale })
    : m.bot_carpool_car_header(
        {
          n: carIndex,
          owner: ownerName,
          free: car.capacity - occupied,
          capacity: car.capacity,
        },
        { locale },
      );

  const lines: string[] = [];
  // Owner is seat #1 with crown
  lines.push(m.bot_carpool_seat_owner({ n: 1, name: ownerName }, { locale }));
  // Passengers starting at seat #2
  car.passengers.forEach((passenger, idx) => {
    lines.push(m.bot_carpool_seat_taken({ n: idx + 2, name: renderMember(passenger) }, { locale }));
  });
  // Free seats
  const freeSeatStart = 1 + car.passengers.length + 1;
  for (let i = freeSeatStart; i <= car.capacity; i++) {
    lines.push(m.bot_carpool_seat_free({ n: i }, { locale }));
  }

  return {
    name: headerText,
    value: lines.join('\n'),
    inline: false,
  };
};

export const buildCarpoolEmbed = (
  view: CarpoolRpcModels.CarpoolView,
  locale: Locale,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const displayedCars = view.cars.slice(0, MAX_CARS_DISPLAYED);

  const totalCars = displayedCars.length;
  const fullCars = displayedCars.filter((car) => 1 + car.passengers.length >= car.capacity).length;

  const color =
    totalCars === 0 ? COLOR_ORANGE : fullCars === totalCars ? COLOR_GREEN : COLOR_BLURPLE;

  const totalFree = displayedCars.reduce(
    (acc, car) => acc + Math.max(0, car.capacity - (1 + car.passengers.length)),
    0,
  );

  const fields: Discord.RichEmbedField[] = [];
  displayedCars.forEach((car, idx) => {
    fields.push(buildCarField(car, idx + 1, locale));
  });

  const descriptionParts: string[] = [m.bot_carpool_intro({}, { locale })];
  if (totalCars > 0) {
    descriptionParts.push(m.bot_carpool_free_total({ count: totalFree }, { locale }));
  }

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      color,
      description: descriptionParts.join('\n'),
      fields,
      footer: { text: m.bot_carpool_footer({}, { locale }) },
    },
  ];

  // Build component rows:
  // Row 1: carpool-add button (always present)
  // Following rows: carpool-reserve:<car_id> buttons, up to 4 per row
  // Discord allows 5 rows max, row 1 is the add button → 4 rows × 4 buttons = 16 reserve buttons
  // But we cap at MAX_CARS_DISPLAYED (10) reserve buttons anyway
  const addRow: Discord.ActionRowComponentForMessageRequest = {
    type: 1,
    components: [
      {
        type: 2,
        style: 1, // Primary
        label: m.bot_carpool_btn_add({}, { locale }),
        // Encode carpool_id so the modal submit handler can call AddCar.
        custom_id: `carpool-add:${view.carpool_id}`,
      },
    ],
  };

  const components: Discord.ActionRowComponentForMessageRequest[] = [addRow];

  // Build reserve button rows (up to 4 buttons each, up to 4 rows after the add row)
  const BUTTONS_PER_ROW = 4;
  for (let i = 0; i < displayedCars.length; i += BUTTONS_PER_ROW) {
    const batch = displayedCars.slice(i, i + BUTTONS_PER_ROW);
    const buttonRow: Discord.ActionRowComponentForMessageRequest = {
      type: 1,
      components: batch.map((car, batchIdx) => {
        const carIndex = i + batchIdx + 1;
        const isFull = 1 + car.passengers.length >= car.capacity;
        return {
          type: 2,
          style: isFull ? 2 : 3, // Secondary when full, Success (green) when available
          label: m.bot_carpool_btn_reserve({ n: carIndex }, { locale }),
          custom_id: `carpool-reserve:${car.car_id}`,
          disabled: isFull,
        };
      }),
    };
    components.push(buttonRow);
    // Discord allows max 5 rows, and row 1 is addRow → stop at 4 reserve rows
    if (components.length >= 5) break;
  }

  return {
    embeds,
    components,
  };
};
