import { Badge } from '~/components/ui/badge';
import { Label } from '~/components/ui/label';
import { Slider } from '~/components/ui/slider';

interface WeightSliderFieldProps {
  id: string;
  label: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function WeightSliderField({
  id,
  label,
  description,
  value,
  onChange,
  disabled,
}: WeightSliderFieldProps) {
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center justify-between'>
        <Label htmlFor={id}>{label}</Label>
        <Badge variant='secondary' className='tabular-nums min-w-10 justify-center'>
          {value}
        </Badge>
      </div>
      {description && <p className='text-xs text-muted-foreground'>{description}</p>}
      <div className='flex items-center gap-3'>
        <Slider
          id={id}
          aria-label={label}
          min={0}
          max={100}
          step={1}
          value={[value]}
          onValueChange={([v]) => onChange(v)}
          disabled={disabled}
          className='flex-1'
        />
      </div>
    </div>
  );
}
