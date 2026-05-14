import { Palette } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

const PRESET_COLORS = [
  '#E74C3C',
  '#E91E63',
  '#9B59B6',
  '#673AB7',
  '#3498DB',
  '#2196F3',
  '#00BCD4',
  '#009688',
  '#2ECC71',
  '#4CAF50',
  '#8BC34A',
  '#CDDC39',
  '#FFC107',
  '#FF9800',
  '#FF5722',
  '#795548',
  '#607D8B',
  '#9E9E9E',
  '#1ABC9C',
  '#F1C40F',
];

interface ColorPickerProps {
  value: string | undefined;
  onChange: (color: string | undefined) => void;
  className?: string;
  id?: string;
}

export function ColorPicker({ value, onChange, className, id }: ColorPickerProps) {
  const [open, setOpen] = React.useState(false);
  const [hexInput, setHexInput] = React.useState(value ?? '');

  React.useEffect(() => {
    setHexInput(value ?? '');
  }, [value]);

  const handleSwatchClick = (color: string) => {
    onChange(color);
    setOpen(false);
  };

  const handleHexChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setHexInput(raw);
    const full = raw.startsWith('#') ? raw : `#${raw}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(full)) {
      onChange(full.toUpperCase());
    }
  };

  const handleClear = () => {
    onChange(undefined);
    setHexInput('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type='button'
          aria-label={value ? `Color: ${value}` : tr('common_color')}
          aria-haspopup='dialog'
          className={cn(
            'w-8 h-8 rounded border flex items-center justify-center shrink-0',
            value
              ? 'border-border'
              : 'border-dashed border-border text-muted-foreground hover:text-foreground',
            className,
          )}
          style={value ? { backgroundColor: value } : undefined}
          title={value ?? tr('common_color')}
        >
          {!value && <Palette className='size-4' />}
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-auto p-3' align='start'>
        <div className='grid grid-cols-5 gap-1 mb-3'>
          {PRESET_COLORS.map((color) => (
            <button
              key={color}
              type='button'
              onClick={() => handleSwatchClick(color)}
              className={cn(
                'w-7 h-7 rounded transition-transform hover:scale-110',
                value?.toUpperCase() === color
                  ? 'ring-2 ring-offset-1 ring-foreground'
                  : 'ring-1 ring-border',
              )}
              style={{ backgroundColor: color }}
              title={color}
            />
          ))}
        </div>
        <div className='flex items-center gap-1 mb-2'>
          <span className='text-sm text-muted-foreground'>#</span>
          <Input
            value={hexInput.replace(/^#/, '')}
            onChange={handleHexChange}
            className='h-7 text-sm'
            placeholder={tr('common_customColor')}
            maxLength={6}
          />
        </div>
        <Button variant='ghost' size='sm' className='w-full text-xs' onClick={handleClear}>
          {tr('common_clearColor')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
