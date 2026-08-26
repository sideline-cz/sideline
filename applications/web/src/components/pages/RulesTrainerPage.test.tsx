// Tests for RulesTrainerPage — a thin, props-only page wrapper (no
// TanStack Router imports) that only decides whether to show the
// Czech-translation-under-review notice.
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

vi.mock('~/components/organisms/RulesTrainer.js', () => ({
  RulesTrainer: ({ locale, isSignedIn }: { locale: string; isSignedIn: boolean }) => (
    <div data-testid='rules-trainer'>
      {locale}/{String(isSignedIn)}
    </div>
  ),
}));

const { RulesTrainerPage } = await import('~/components/pages/RulesTrainerPage.js');

describe('RulesTrainerPage', () => {
  it('renders the trainer with the given locale and no notice by default, signed out', () => {
    render(<RulesTrainerPage locale='en' />);
    expect(screen.getByTestId('rules-trainer')).toHaveProperty('textContent', 'en/false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('threads `isSignedIn` through to the organism', () => {
    render(<RulesTrainerPage locale='en' isSignedIn />);
    expect(screen.getByTestId('rules-trainer')).toHaveProperty('textContent', 'en/true');
  });
});
