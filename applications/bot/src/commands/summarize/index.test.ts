// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import * as DiscordTypes from 'dfx/types';
import { describe, expect, it } from 'vitest';
import { SummarizeCommand } from '~/commands/summarize/index.js';

// ---------------------------------------------------------------------------
// Tests — SummarizeCommand definition
// ---------------------------------------------------------------------------

describe('SummarizeCommand', () => {
  it('command name is "summarize"', () => {
    // SummarizeCommand is an Ix.global(...) object; the definition is stored
    // in the first argument. Access .command.name or .definition.name
    // depending on how dfx exposes it. Either shape should work.
    const cmd = SummarizeCommand as unknown as {
      command?: { name?: string };
      definition?: { name?: string };
      name?: string;
    };
    const name = cmd.command?.name ?? cmd.definition?.name ?? cmd.name ?? '';
    expect(name).toBe('summarize');
  });

  it('has a "messages" option of type INTEGER', () => {
    const cmd = SummarizeCommand as unknown as {
      command?: { options?: ReadonlyArray<{ name: string; type: number }> };
      definition?: { options?: ReadonlyArray<{ name: string; type: number }> };
    };
    const options = cmd.command?.options ?? cmd.definition?.options ?? [];
    const messagesOpt = options.find((o) => o.name === 'messages');
    expect(messagesOpt).toBeDefined();
    expect(messagesOpt?.type).toBe(DiscordTypes.ApplicationCommandOptionType.INTEGER);
  });

  it('has a "since" option of type STRING', () => {
    const cmd = SummarizeCommand as unknown as {
      command?: { options?: ReadonlyArray<{ name: string; type: number }> };
      definition?: { options?: ReadonlyArray<{ name: string; type: number }> };
    };
    const options = cmd.command?.options ?? cmd.definition?.options ?? [];
    const sinceOpt = options.find((o) => o.name === 'since');
    expect(sinceOpt).toBeDefined();
    expect(sinceOpt?.type).toBe(DiscordTypes.ApplicationCommandOptionType.STRING);
  });

  it('"messages" option has min_value=1 and max_value=200', () => {
    const cmd = SummarizeCommand as unknown as {
      command?: {
        options?: ReadonlyArray<{ name: string; min_value?: number; max_value?: number }>;
      };
      definition?: {
        options?: ReadonlyArray<{ name: string; min_value?: number; max_value?: number }>;
      };
    };
    const options = cmd.command?.options ?? cmd.definition?.options ?? [];
    const messagesOpt = options.find((o) => o.name === 'messages');
    expect(messagesOpt?.min_value).toBe(1);
    expect(messagesOpt?.max_value).toBe(200);
  });
});
