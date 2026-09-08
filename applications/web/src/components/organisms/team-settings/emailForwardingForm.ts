import type { EmailForwardingApi } from '@sideline/domain';
import { Discord } from '@sideline/domain';
import { Option } from 'effect';
import { NONE_VALUE } from './shared';

/**
 * The primitive fields the email-forwarding Save button owns.
 *
 * Two of the card's inputs deliberately live outside this type, because the
 * shallow `!==` dirty check in `useCardForm` cannot express them:
 *
 * - `monitoredAddresses` is an array, so every render would produce a new
 *   reference and read as dirty forever.
 * - `imapSecret` is write-only and three-state: whether a typed value counts
 *   as a change depends on `imapSecretSet` and `replacingSecret`, not on
 *   inequality against a baseline (the saved value is never sent to us).
 *
 * The card ORs those two in explicitly. Everything else goes through the form,
 * so `emailForwardingForm.test.ts` can hold the field list and the payload to
 * the same standard as `settingsForm.ts`.
 */
export type EmailForwardingFormValues = {
  enabled: boolean;
  coachChannelId: string;
  targetChannelId: string;
  imapEnabled: boolean;
  imapHost: string;
  imapPort: string;
  imapUseTls: boolean;
  imapUsername: string;
  imapFolder: string;
};

type Config = EmailForwardingApi.EmailForwardingConfigView | null;

const DEFAULT_IMAP_PORT = '993';
/** The server treats an absent folder as INBOX; send it explicitly. */
const DEFAULT_IMAP_FOLDER = 'INBOX';

export const emailForwardingFormFrom = (config: Config): EmailForwardingFormValues => ({
  enabled: config?.enabled ?? false,
  coachChannelId: config?.coachChannelId || NONE_VALUE,
  targetChannelId: config?.targetChannelId || NONE_VALUE,
  imapEnabled: config?.imapEnabled ?? false,
  imapHost: Option.getOrElse(config?.imapHost ?? Option.none<string>(), () => ''),
  imapPort: Option.match(config?.imapPort ?? Option.none<number>(), {
    onNone: () => DEFAULT_IMAP_PORT,
    onSome: (p) => String(p),
  }),
  imapUseTls: config?.imapUseTls ?? true,
  imapUsername: Option.getOrElse(config?.imapUsername ?? Option.none<string>(), () => ''),
  imapFolder: Option.getOrElse(config?.imapFolder ?? Option.none<string>(), () => ''),
});

/** Per-field translation keys, so the card can keep rendering errors inline. */
export interface EmailForwardingErrors {
  imapHost?: string;
  imapPort?: string;
  imapUsername?: string;
  imapSecret?: string;
}

/**
 * Pure counterpart of the old `validateImapFields`, which computed and
 * `setState`-ed in one pass and so could only be exercised by rendering.
 *
 * Returns a key per bad field rather than a single "first invalid" key: this
 * card shows errors next to the inputs, which is better than one toast naming
 * one field, and that behaviour is worth preserving through the conversion.
 */
export const validateEmailForwarding = (
  values: EmailForwardingFormValues,
  options: {
    readonly imapSecretSet: boolean;
    readonly replacingSecret: boolean;
    readonly imapSecret: string;
  },
): EmailForwardingErrors => {
  // Everything below only applies to the IMAP poller.
  if (!values.imapEnabled) return {};

  const errors: EmailForwardingErrors = {};

  if (!values.imapHost.trim()) {
    errors.imapHost = 'team_email_forwarding_imap_host_required';
  }
  if (!values.imapUsername.trim()) {
    errors.imapUsername = 'team_email_forwarding_imap_username_required';
  }

  const port = Number(values.imapPort);
  if (!values.imapPort.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.imapPort = 'team_email_forwarding_imap_port_invalid';
  }

  // Required only when there is no stored secret, or the person chose to
  // replace the one there is.
  const needsSecret = !options.imapSecretSet || options.replacingSecret;
  if (needsSecret && !options.imapSecret.trim()) {
    errors.imapSecret = 'team_email_forwarding_imap_secret_required';
  }

  return errors;
};

export const hasEmailForwardingErrors = (errors: EmailForwardingErrors): boolean =>
  Object.values(errors).some((v) => v !== undefined);

/**
 * `Option.none()` means "keep the stored secret": the saved value is never
 * sent back to the browser, so an untouched field must omit the key rather
 * than post an empty string and wipe it.
 */
export const imapSecretPayload = (options: {
  readonly imapSecretSet: boolean;
  readonly replacingSecret: boolean;
  readonly imapSecret: string;
}): Option.Option<string> => {
  if (options.imapSecretSet && !options.replacingSecret) return Option.none();
  return options.imapSecret.trim() ? Option.some(options.imapSecret.trim()) : Option.none();
};

const channelOrEmpty = (value: string): Discord.Snowflake =>
  Discord.Snowflake.makeUnsafe(value !== NONE_VALUE ? value : '');

export const emailForwardingRequestFrom = (
  values: EmailForwardingFormValues,
  extras: {
    readonly monitoredAddresses: ReadonlyArray<string>;
    readonly imapSecret: Option.Option<string>;
  },
): EmailForwardingApi.UpsertEmailForwardingConfigRequest => {
  const port = Number(values.imapPort);
  return {
    enabled: values.enabled,
    coach_channel_id: channelOrEmpty(values.coachChannelId),
    target_channel_id: channelOrEmpty(values.targetChannelId),
    monitored_addresses: [...extras.monitoredAddresses],
    imap_enabled: values.imapEnabled,
    imap_host: values.imapHost.trim() ? Option.some(values.imapHost.trim()) : Option.none(),
    imap_port: Number.isInteger(port) && port >= 1 ? Option.some(port) : Option.none(),
    imap_username: values.imapUsername.trim()
      ? Option.some(values.imapUsername.trim())
      : Option.none(),
    imap_use_tls: values.imapUseTls,
    imap_folder: Option.some(values.imapFolder.trim() || DEFAULT_IMAP_FOLDER),
    imap_secret: extras.imapSecret,
  };
};
