import { TeamChannelAccess } from '@sideline/domain';
import { Schema } from 'effect';
import { Select, SelectContent, SelectItem, SelectTrigger } from '~/components/ui/select';
import { tr } from '~/lib/translations.js';

interface AccessLevelSelectProps {
  value: TeamChannelAccess.AccessLevel;
  onValueChange: (value: TeamChannelAccess.AccessLevel) => void;
  disabled?: boolean;
  className?: string;
}

const levels: ReadonlyArray<TeamChannelAccess.AccessLevel> = ['VIEW', 'EDIT', 'ADMIN'];

const labelMap: Record<TeamChannelAccess.AccessLevel, Parameters<typeof tr>[0]> = {
  VIEW: 'channels_accessLevel_view',
  EDIT: 'channels_accessLevel_edit',
  ADMIN: 'channels_accessLevel_admin',
};

const helpMap: Record<TeamChannelAccess.AccessLevel, Parameters<typeof tr>[0]> = {
  VIEW: 'channels_accessLevel_view_help',
  EDIT: 'channels_accessLevel_edit_help',
  ADMIN: 'channels_accessLevel_admin_help',
};

export function AccessLevelSelect({
  value,
  onValueChange,
  disabled,
  className,
}: AccessLevelSelectProps) {
  const handleChange = (v: string) => {
    Schema.decodeUnknownOption(TeamChannelAccess.AccessLevel)(v).pipe((opt) => {
      if (opt._tag === 'Some') {
        onValueChange(opt.value);
      }
    });
  };

  return (
    <Select value={value} onValueChange={handleChange} disabled={disabled}>
      <SelectTrigger aria-label={tr('channels_accessLevel_label')} className={className} size='sm'>
        {/* Show only the label in the collapsed trigger; the per-option description
            lives in the dropdown items below (SelectValue would mirror both and overflow). */}
        <span className='truncate'>{tr(labelMap[value])}</span>
      </SelectTrigger>
      <SelectContent>
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            <span className='flex flex-col gap-0.5'>
              <span className='font-medium'>{tr(labelMap[level])}</span>
              <span className='text-xs text-muted-foreground'>{tr(helpMap[level])}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
