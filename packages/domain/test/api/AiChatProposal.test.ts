import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import {
  ChatResponse,
  Proposal,
  ProposalField,
  ProposalFieldKey,
  ProposalFieldValue,
} from '~/api/AiChatApi.js';

// The proposal is the one part of the assistant's wire contract that describes a WRITE the user
// is about to authorise, so the properties worth pinning here are the ones that make the card
// verifiable rather than merely renderable:
//
//   - the summary survives a decode/encode round trip byte-identically, because the client is
//     required to render the server's output verbatim and derive nothing itself;
//   - `type` is a closed discriminant, so an unrecognised variant is a decode failure rather
//     than a silently-dropped row in a list the user is reading before confirming;
//   - `date` stays a bare `YYYY-MM-DD` string and never becomes a `DateTime`, because an
//     all-day date re-interpreted through a browser offset lands on the wrong day;
//   - `proposal: null` decodes, since that is what every read-only turn sends.

const PROPOSAL_ID = '3f2a6c18-9b4e-4d2a-8c51-7e0d1f6a2b93';

const wireProposal = {
  id: PROPOSAL_ID,
  action: 'create_event',
  summary: [
    { key: 'title', value: { type: 'text', value: 'Tuesday Training' } },
    { key: 'eventType', value: { type: 'eventType', value: 'training' } },
    { key: 'start', value: { type: 'instant', value: '2026-05-12T17:00:00.000Z' } },
    { key: 'end', value: { type: 'none' } },
    { key: 'trainingType', value: { type: 'text', value: 'Indoor' } },
    { key: 'ownerGroup', value: { type: 'none' } },
    { key: 'memberGroup', value: { type: 'none' } },
    { key: 'location', value: { type: 'text', value: 'Main Field' } },
    { key: 'description', value: { type: 'none' } },
  ],
  expiresAt: '2026-05-12T16:15:00.000Z',
};

describe('Proposal', () => {
  it('round-trips a wire object byte-identically', () => {
    const decoded = Schema.decodeUnknownSync(Proposal)(wireProposal);
    expect(Schema.encodeSync(Proposal)(decoded)).toStrictEqual(wireProposal);
  });

  it('rejects an id that is not a UUID', () => {
    // A non-UUID reaching the `UUID` column raises 22P02, which becomes a LogicError defect and
    // a 500 — instead of the 404 the endpoint's taxonomy promises. The brand's check is what
    // keeps that from ever reaching SQL.
    const result = Schema.decodeUnknownEffect(Proposal)({ ...wireProposal, id: 'not-a-uuid' }).pipe(
      Effect.result,
      Effect.runSync,
    );
    expect(result._tag).toBe('Failure');
  });

  it('rejects an unknown action', () => {
    const result = Schema.decodeUnknownEffect(Proposal)({
      ...wireProposal,
      action: 'delete_everything',
    }).pipe(Effect.result, Effect.runSync);
    expect(result._tag).toBe('Failure');
  });
});

describe('ProposalFieldValue', () => {
  const variants = [
    { type: 'text', value: 'Tuesday Training' },
    { type: 'instant', value: '2026-05-12T17:00:00.000Z' },
    { type: 'date', value: '2026-07-04' },
    { type: 'eventType', value: 'training' },
    { type: 'none' },
  ];

  it.each(variants)('accepts the $type variant', (variant) => {
    expect(() => Schema.decodeUnknownSync(ProposalFieldValue)(variant)).not.toThrow();
  });

  it('rejects an unknown type discriminant', () => {
    const result = Schema.decodeUnknownEffect(ProposalFieldValue)({
      type: 'markdown',
      value: '**bold**',
    }).pipe(Effect.result, Effect.runSync);
    expect(result._tag).toBe('Failure');
  });

  it('keeps `date` a bare YYYY-MM-DD string, never a DateTime', () => {
    // If this ever decodes to a DateTime, the client will format it through a browser offset and
    // an all-day event will display on the wrong day for every non-zero-offset reader.
    const decoded = Schema.decodeUnknownSync(ProposalFieldValue)({
      type: 'date',
      value: '2026-07-04',
    });
    expect(decoded).toStrictEqual({ type: 'date', value: '2026-07-04' });
  });

  it('rejects a date that is not a calendar date', () => {
    const result = Schema.decodeUnknownEffect(ProposalField)({
      key: 'start',
      value: { type: 'instant', value: 'yesterday' },
    }).pipe(Effect.result, Effect.runSync);
    expect(result._tag).toBe('Failure');
  });
});

describe('ProposalFieldKey', () => {
  it('is the exact set the card renders, in a fixed order', () => {
    // The client's label map is a `Record` over this union, so adding a literal here without
    // adding its label is a web BUILD failure rather than a raw key on a confirmation card.
    expect([...ProposalFieldKey.literals]).toStrictEqual([
      'title',
      'eventType',
      'start',
      'end',
      'trainingType',
      'ownerGroup',
      'memberGroup',
      'location',
      'description',
    ]);
  });
});

describe('ChatResponse.proposal', () => {
  const baseResponse = {
    answer: 'Here are your trainings.',
    generated: true,
    degradedReason: null,
    references: [],
  };

  it('decodes `null` — the shape every read-only turn sends', () => {
    const decoded = Schema.decodeUnknownSync(ChatResponse)({ ...baseResponse, proposal: null });
    expect(decoded.proposal._tag).toBe('None');
  });

  it('decodes a present proposal', () => {
    const decoded = Schema.decodeUnknownSync(ChatResponse)({
      ...baseResponse,
      proposal: wireProposal,
    });
    expect(decoded.proposal._tag).toBe('Some');
  });
});
