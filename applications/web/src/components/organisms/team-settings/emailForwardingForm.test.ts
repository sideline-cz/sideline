// Same standard as `settingsForm.test.ts`: every field the form tracks must
// reach the payload, enforced by iterating the type rather than by discipline.
//
// This card is the awkward case the pattern has to survive — two of its inputs
// cannot go through the shallow dirty check at all (an array, and a write-only
// three-state secret), so the invariant is only as good as the boundary
// between what is in the form and what is folded in beside it.

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  type EmailForwardingFormValues,
  emailForwardingRequestFrom,
  hasEmailForwardingErrors,
  imapSecretPayload,
  validateEmailForwarding,
} from './emailForwardingForm';
import { NONE_VALUE } from './shared';
import { isFormDirty } from './useCardForm';

const BASE: EmailForwardingFormValues = {
  enabled: false,
  coachChannelId: NONE_VALUE,
  targetChannelId: NONE_VALUE,
  imapEnabled: false,
  imapHost: '',
  imapPort: '993',
  imapUseTls: true,
  imapUsername: '',
  imapFolder: '',
};

/** Typed as the form, so a new field with no test value is a compile error. */
const EDITED: EmailForwardingFormValues = {
  enabled: true,
  coachChannelId: '111111111111111111',
  targetChannelId: '222222222222222222',
  imapEnabled: true,
  imapHost: 'imap.example.com',
  imapPort: '143',
  imapUseTls: false,
  imapUsername: 'coach@example.com',
  imapFolder: 'Archive',
};

const FIELDS = Object.keys(BASE) as ReadonlyArray<keyof EmailForwardingFormValues>;
const edit = (key: keyof EmailForwardingFormValues): EmailForwardingFormValues => ({
  ...BASE,
  [key]: EDITED[key],
});

const NO_SECRET = { monitoredAddresses: [], imapSecret: Option.none<string>() };

describe('EmailForwardingFormValues', () => {
  it('gives every field a distinct edited value', () => {
    for (const key of FIELDS) {
      expect(EDITED[key], `EDITED.${key} must differ from BASE.${key}`).not.toBe(BASE[key]);
    }
  });

  describe('every field enables the Save button', () => {
    it.each(FIELDS)('%s', (key) => {
      expect(isFormDirty(BASE, edit(key))).toBe(true);
    });
  });

  describe('every field the form tracks is actually sent', () => {
    const baseRequest = JSON.stringify(emailForwardingRequestFrom(BASE, NO_SECRET));
    it.each(FIELDS)('%s', (key) => {
      expect(JSON.stringify(emailForwardingRequestFrom(edit(key), NO_SECRET))).not.toBe(
        baseRequest,
      );
    });
  });
});

describe('emailForwardingRequestFrom', () => {
  it('sends an unpicked channel as an empty id, which is how this endpoint clears it', () => {
    const req = emailForwardingRequestFrom(BASE, NO_SECRET);
    expect(req.coach_channel_id).toBe('');
    expect(req.target_channel_id).toBe('');
  });

  it('defaults an empty folder to INBOX — the value the server would store anyway', () => {
    expect(emailForwardingRequestFrom(BASE, NO_SECRET).imap_folder).toStrictEqual(
      Option.some('INBOX'),
    );
  });

  it('omits an unparseable port rather than sending NaN', () => {
    const req = emailForwardingRequestFrom({ ...BASE, imapPort: '' }, NO_SECRET);
    expect(req.imap_port).toStrictEqual(Option.none());
  });

  it('trims host and username', () => {
    const req = emailForwardingRequestFrom(
      { ...BASE, imapHost: '  imap.example.com  ', imapUsername: '  coach  ' },
      NO_SECRET,
    );
    expect(req.imap_host).toStrictEqual(Option.some('imap.example.com'));
    expect(req.imap_username).toStrictEqual(Option.some('coach'));
  });

  it('copies the addresses rather than aliasing the caller’s array', () => {
    const addresses = ['a@example.com'];
    const req = emailForwardingRequestFrom(BASE, {
      monitoredAddresses: addresses,
      imapSecret: Option.none(),
    });
    addresses.push('b@example.com');
    expect(req.monitored_addresses).toEqual(['a@example.com']);
  });
});

// The saved secret is never sent back to the browser, so an untouched field
// must omit the key rather than post an empty string and wipe it.
describe('imapSecretPayload', () => {
  it('keeps the stored secret when one is set and it is not being replaced', () => {
    expect(
      imapSecretPayload({ imapSecretSet: true, replacingSecret: false, imapSecret: '' }),
    ).toStrictEqual(Option.none());
  });

  it('sends a typed secret when none is stored yet', () => {
    expect(
      imapSecretPayload({ imapSecretSet: false, replacingSecret: false, imapSecret: 'hunter2' }),
    ).toStrictEqual(Option.some('hunter2'));
  });

  it('sends the replacement when the person chose to replace', () => {
    expect(
      imapSecretPayload({ imapSecretSet: true, replacingSecret: true, imapSecret: 'new' }),
    ).toStrictEqual(Option.some('new'));
  });

  it('does not wipe a stored secret when the replacement box is left empty', () => {
    expect(
      imapSecretPayload({ imapSecretSet: true, replacingSecret: true, imapSecret: '   ' }),
    ).toStrictEqual(Option.none());
  });
});

describe('validateEmailForwarding', () => {
  const opts = { imapSecretSet: false, replacingSecret: false, imapSecret: 'pw' };

  it('checks nothing while the IMAP poller is off', () => {
    const errors = validateEmailForwarding(
      { ...BASE, imapEnabled: false, imapPort: 'nonsense' },
      {
        imapSecretSet: false,
        replacingSecret: false,
        imapSecret: '',
      },
    );
    expect(errors).toEqual({});
    expect(hasEmailForwardingErrors(errors)).toBe(false);
  });

  it('accepts a complete IMAP config', () => {
    expect(validateEmailForwarding(EDITED, opts)).toEqual({});
  });

  it('reports every bad field at once, so each renders next to its input', () => {
    const errors = validateEmailForwarding(
      { ...BASE, imapEnabled: true, imapPort: '0' },
      { imapSecretSet: false, replacingSecret: false, imapSecret: '' },
    );
    expect(Object.keys(errors).sort()).toEqual([
      'imapHost',
      'imapPort',
      'imapSecret',
      'imapUsername',
    ]);
  });

  it.each(['0', '65536', '', 'abc', '99.5'])('rejects port %s', (port) => {
    expect(validateEmailForwarding({ ...EDITED, imapPort: port }, opts).imapPort).toBe(
      'team_email_forwarding_imap_port_invalid',
    );
  });

  it('does not demand a secret that is already stored', () => {
    const errors = validateEmailForwarding(EDITED, {
      imapSecretSet: true,
      replacingSecret: false,
      imapSecret: '',
    });
    expect(errors.imapSecret).toBeUndefined();
  });

  it('demands one once the person chooses to replace it', () => {
    const errors = validateEmailForwarding(EDITED, {
      imapSecretSet: true,
      replacingSecret: true,
      imapSecret: '',
    });
    expect(errors.imapSecret).toBe('team_email_forwarding_imap_secret_required');
  });
});
