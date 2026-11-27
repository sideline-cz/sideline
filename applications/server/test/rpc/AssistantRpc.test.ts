import { describe, expect, it } from '@effect/vitest';
import type { AiChatApi } from '@sideline/domain';
import { Option } from 'effect';
import { renderAnswer, toAssistantTurn } from '~/rpc/assistant/index.js';

const groupRef = {
  kind: 'group',
  ref: 'ab12',
  group: { name: 'Juniors' },
} as unknown as AiChatApi.EntityRef;

describe('Assistant RPC rendering', () => {
  it('replaces a cited ref marker with the entity name in bold', () => {
    expect(renderAnswer('Ask [[ref:ab12]] for help.', [groupRef])).toBe(
      'Ask **Juniors** for help.',
    );
  });

  it('drops a marker with no matching reference', () => {
    expect(renderAnswer('Nothing here[[ref:zz99]].', [groupRef])).toBe('Nothing here.');
  });

  it('flattens a degraded turn to its reason, with no proposal', () => {
    expect(
      toAssistantTurn({
        answer: '',
        generated: false,
        degradedReason: Option.some('disabled'),
        references: [],
        proposal: Option.none(),
      }),
    ).toEqual({ answer: '', degraded_reason: 'disabled', proposal: null });
  });
});
