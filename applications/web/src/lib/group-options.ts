import type { GroupApi } from '@sideline/domain';
import { Option } from 'effect';

type GroupLike = Pick<GroupApi.GroupInfo, 'groupId' | 'name' | 'emoji'>;

export const toGroupOptionLabel = (g: GroupLike): string =>
  g.emoji.pipe(
    Option.map((v) => `${v} ${g.name}`),
    Option.getOrElse(() => g.name),
  );

export const toGroupOptions = (
  groups: ReadonlyArray<GroupLike>,
): ReadonlyArray<{ readonly value: string; readonly label: string }> =>
  groups.map((g) => ({
    value: g.groupId,
    label: toGroupOptionLabel(g),
  }));
