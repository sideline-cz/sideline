import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import type { GroupApi } from '@sideline/domain';
import { GroupModel, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { ChevronDown, ChevronRight } from 'lucide-react';
import React from 'react';
import { useForm } from 'react-hook-form';
import { ColorDot } from '~/components/atoms/ColorDot.js';
import { ColorPicker } from '~/components/atoms/ColorPicker.js';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Button } from '~/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';
import { withFieldErrors } from '~/lib/form';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const CreateGroupSchema = Schema.Struct({
  name: Schema.NonEmptyString.annotate({ message: tr('validation_required') }),
});

type CreateGroupValues = Schema.Schema.Type<typeof CreateGroupSchema>;

interface TreeNode {
  group: GroupApi.GroupInfo;
  children: TreeNode[];
}

function buildTree(groups: ReadonlyArray<GroupApi.GroupInfo>): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const g of groups) {
    byId.set(g.groupId, { group: g, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const g of groups) {
    const node = byId.get(g.groupId);
    if (!node) continue;
    if (Option.isSome(g.parentId) && byId.has(g.parentId.value)) {
      byId.get(g.parentId.value)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

interface GroupTreeNodeProps {
  node: TreeNode;
  teamId: string;
  depth: number;
  onCreateSubgroup: (parentId: string) => void;
}

function GroupTreeNode({ node, teamId, depth, onCreateSubgroup }: GroupTreeNodeProps) {
  const [expanded, setExpanded] = React.useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <>
      <tr className='border-b'>
        <td className='py-2 px-4'>
          <div className='flex items-center' style={{ paddingLeft: `${depth * 24}px` }}>
            {hasChildren ? (
              <button
                type='button'
                onClick={() => setExpanded((v) => !v)}
                className='mr-1 p-0.5 rounded hover:bg-muted'
              >
                {expanded ? (
                  <ChevronDown className='size-4' />
                ) : (
                  <ChevronRight className='size-4' />
                )}
              </button>
            ) : (
              <span className='mr-1 w-5' />
            )}
            <div className='min-w-0 flex items-center gap-2'>
              <ColorDot color={Option.getOrUndefined(node.group.color)} />
              <Link
                to='/teams/$teamId/groups/$groupId'
                params={{ teamId, groupId: node.group.groupId }}
                className='font-medium hover:underline'
              >
                {Option.isSome(node.group.emoji)
                  ? `${node.group.emoji.value} ${node.group.name}`
                  : node.group.name}
              </Link>
              <p className='text-xs text-muted-foreground sm:hidden'>
                {tr('group_memberCount', { count: String(node.group.memberCount) })}
              </p>
            </div>
          </div>
        </td>
        <td className='hidden sm:table-cell py-2 px-4 text-muted-foreground'>
          {tr('group_memberCount', { count: String(node.group.memberCount) })}
        </td>
        <td className='py-2 px-4'>
          <div className='flex gap-1 flex-wrap'>
            <Button variant='ghost' size='sm' onClick={() => onCreateSubgroup(node.group.groupId)}>
              {tr('group_createSubgroup')}
            </Button>
            <Button asChild variant='outline' size='sm'>
              <Link
                to='/teams/$teamId/groups/$groupId'
                params={{ teamId, groupId: node.group.groupId }}
              >
                View
              </Link>
            </Button>
          </div>
        </td>
      </tr>
      {expanded &&
        node.children.map((child) => (
          <GroupTreeNode
            key={child.group.groupId}
            node={child}
            teamId={teamId}
            depth={depth + 1}
            onCreateSubgroup={onCreateSubgroup}
          />
        ))}
    </>
  );
}

interface GroupsListPageProps {
  teamId: string;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

export function GroupsListPage({ teamId, groups }: GroupsListPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const [selectedParentId, setSelectedParentId] = React.useState<string>('__root__');
  const [createEmoji, setCreateEmoji] = React.useState('');
  const [createColor, setCreateColor] = React.useState<string | undefined>(undefined);

  const tree = React.useMemo(() => buildTree(groups), [groups]);

  const form = useForm({
    resolver: standardSchemaResolver(Schema.toStandardSchemaV1(CreateGroupSchema)),
    mode: 'onChange',
    defaultValues: { name: '' },
  });

  const onSubmit = async (values: CreateGroupValues) => {
    const parentId =
      selectedParentId === '__root__'
        ? Option.none()
        : Option.some(Schema.decodeSync(GroupModel.GroupId)(selectedParentId));
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.group.createGroup({
          params: { teamId: teamIdBranded },
          payload: {
            name: values.name,
            parentId,
            emoji: createEmoji ? Option.some(createEmoji) : Option.none(),
            color: createColor ? Option.some(createColor) : Option.none(),
          },
        }),
      ),
      withFieldErrors(form, [
        { tag: 'GroupNameAlreadyTaken', field: 'name', message: tr('group_nameAlreadyTaken') },
      ]),
      Effect.mapError(() => ClientError.make(tr('group_createFailed'))),
      run({ success: tr('group_groupCreated') }),
    );
    if (Option.isSome(result)) {
      form.reset();
      setSelectedParentId('__root__');
      setCreateEmoji('');
      setCreateColor(undefined);
      router.invalidate();
    }
  };

  const handleCreateSubgroup = React.useCallback((parentId: string) => {
    setSelectedParentId(parentId);
    document.getElementById('group-name-input')?.focus();
  }, []);

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('group_groups')}</h1>
      </header>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className='flex flex-col gap-4 mb-6 sm:flex-row sm:items-end sm:max-w-lg'
        >
          <div className='flex gap-2 items-end'>
            <div className='flex flex-col'>
              <label htmlFor='group-create-emoji' className='text-sm font-medium mb-1'>
                {tr('roster_emoji')}
              </label>
              <Input
                id='group-create-emoji'
                value={createEmoji}
                onChange={(e) => setCreateEmoji(e.target.value)}
                className='w-16 shrink-0'
                placeholder='🏅'
              />
            </div>
            <div className='flex flex-col'>
              <label htmlFor='group-create-color' className='text-sm font-medium mb-1'>
                {tr('common_color')}
              </label>
              <ColorPicker id='group-create-color' value={createColor} onChange={setCreateColor} />
            </div>
            <FormField
              {...form.register('name')}
              render={({ field }) => (
                <FormItem className='flex-1 min-w-48'>
                  <FormLabel>{tr('group_groupName')}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      id='group-name-input'
                      placeholder={tr('group_groupNamePlaceholder')}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <div className='flex flex-col'>
            <label htmlFor='parent-group-select' className='text-sm font-medium mb-1'>
              {tr('group_parentGroup')}
            </label>
            <SearchableSelect
              id='parent-group-select'
              className='w-full sm:w-48'
              value={selectedParentId}
              onValueChange={setSelectedParentId}
              pinnedValues={['__root__']}
              options={[
                { value: '__root__', label: tr('group_rootGroup') },
                ...groups.map((g) => ({
                  value: g.groupId,
                  label: g.emoji.pipe(
                    Option.map((v) => `${v} ${g.name}`),
                    Option.getOrElse(() => g.name),
                  ),
                })),
              ]}
            />
          </div>
          <Button type='submit' disabled={form.formState.isSubmitting}>
            {tr('group_createGroup')}
          </Button>
        </form>
      </Form>

      {groups.length === 0 ? (
        <p className='text-muted-foreground'>{tr('group_noGroups')}</p>
      ) : (
        <table className='w-full'>
          <tbody>
            {tree.map((node) => (
              <GroupTreeNode
                key={node.group.groupId}
                node={node}
                teamId={teamId}
                depth={0}
                onCreateSubgroup={handleCreateSubgroup}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
