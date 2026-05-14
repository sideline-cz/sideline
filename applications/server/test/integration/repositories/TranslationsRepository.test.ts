import { describe, expect, it } from '@effect/vitest';
import type { Translations } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { TranslationsRepository } from '~/repositories/TranslationsRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = TranslationsRepository.Default.pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TranslationsRepository', () => {
  describe('findAll / getVersion', () => {
    it.effect('returns empty array and version 1 on fresh db', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.bind('overrides', ({ repo }) => repo.findAll()),
        Effect.bind('version', ({ repo }) => repo.getVersion()),
        Effect.tap(({ overrides, version }) =>
          Effect.sync(() => {
            expect(overrides).toHaveLength(0);
            expect(version).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('upsert', () => {
    it.effect('inserts a new translation and bumps version', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.bind('v1', ({ repo }) =>
          repo.upsert({
            key: 'app_name' as Translations.TranslationKey,
            locale: 'en',
            value: 'Sideline Custom',
            updatedBy: null,
          }),
        ),
        Effect.bind('overrides', ({ repo }) => repo.findAll()),
        Effect.bind('version', ({ repo }) => repo.getVersion()),
        Effect.tap(({ v1, overrides, version }) =>
          Effect.sync(() => {
            expect(v1).toBeGreaterThan(1);
            expect(overrides).toHaveLength(1);
            expect(overrides[0]?.key).toBe('app_name');
            expect(overrides[0]?.locale).toBe('en');
            expect(overrides[0]?.value).toBe('Sideline Custom');
            expect(version).toBe(v1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect('updates existing translation on conflict', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.tap(({ repo }) =>
          repo.upsert({
            key: 'app_name' as Translations.TranslationKey,
            locale: 'cs',
            value: 'Sideline CZ',
            updatedBy: null,
          }),
        ),
        Effect.tap(({ repo }) =>
          repo.upsert({
            key: 'app_name' as Translations.TranslationKey,
            locale: 'cs',
            value: 'Sideline CZ Updated',
            updatedBy: null,
          }),
        ),
        Effect.bind('overrides', ({ repo }) => repo.findAll()),
        Effect.tap(({ overrides }) =>
          Effect.sync(() => {
            expect(overrides).toHaveLength(1);
            expect(overrides[0]?.value).toBe('Sideline CZ Updated');
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect('stores empty string as a valid value', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.tap(({ repo }) =>
          repo.upsert({
            key: 'app_welcome' as Translations.TranslationKey,
            locale: 'en',
            value: '',
            updatedBy: null,
          }),
        ),
        Effect.bind('overrides', ({ repo }) => repo.findAll()),
        Effect.tap(({ overrides }) =>
          Effect.sync(() => {
            expect(overrides).toHaveLength(1);
            expect(overrides[0]?.value).toBe('');
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('delete_', () => {
    it.effect('removes an existing override and bumps version', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.tap(({ repo }) =>
          repo.upsert({
            key: 'app_name' as Translations.TranslationKey,
            locale: 'en',
            value: 'Custom',
            updatedBy: null,
          }),
        ),
        Effect.bind('vBefore', ({ repo }) => repo.getVersion()),
        Effect.bind('vAfter', ({ repo }) =>
          repo.delete_({
            key: 'app_name' as Translations.TranslationKey,
            locale: 'en',
          }),
        ),
        Effect.bind('overrides', ({ repo }) => repo.findAll()),
        Effect.tap(({ vBefore, vAfter, overrides }) =>
          Effect.sync(() => {
            expect(vAfter).toBeGreaterThan(vBefore);
            expect(overrides).toHaveLength(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );

    it.effect('no-op delete still bumps version', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.bind('vBefore', ({ repo }) => repo.getVersion()),
        Effect.bind('vAfter', ({ repo }) =>
          repo.delete_({
            key: 'nonexistent_key' as Translations.TranslationKey,
            locale: 'en',
          }),
        ),
        Effect.tap(({ vBefore, vAfter }) =>
          Effect.sync(() => {
            expect(vAfter).toBeGreaterThan(vBefore);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('importMerge', () => {
    it.effect('bulk upserts multiple entries and bumps version once', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.bind('vBefore', ({ repo }) => repo.getVersion()),
        Effect.bind('vAfter', ({ repo }) =>
          repo.importMerge({
            entries: [
              {
                key: 'app_name' as Translations.TranslationKey,
                locale: 'en',
                value: 'Custom EN',
              },
              {
                key: 'app_name' as Translations.TranslationKey,
                locale: 'cs',
                value: 'Custom CS',
              },
              {
                key: 'app_welcome' as Translations.TranslationKey,
                locale: 'en',
                value: 'Welcome!',
              },
            ],
            updatedBy: null,
          }),
        ),
        Effect.bind('overrides', ({ repo }) => repo.findAll()),
        Effect.bind('version', ({ repo }) => repo.getVersion()),
        Effect.tap(({ vBefore, vAfter, overrides, version }) =>
          Effect.sync(() => {
            // Version bumped exactly once
            expect(vAfter).toBe(vBefore + 1);
            expect(version).toBe(vAfter);
            // All 3 entries stored
            expect(overrides).toHaveLength(3);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });

  describe('updatedBy', () => {
    it.effect('stores updatedBy as Option.none when inserted without user', () =>
      Effect.Do.pipe(
        Effect.bind('repo', () => TranslationsRepository.asEffect()),
        Effect.tap(({ repo }) =>
          repo.upsert({
            key: 'app_name' as Translations.TranslationKey,
            locale: 'en',
            value: 'Test',
            updatedBy: null,
          }),
        ),
        Effect.bind('overrides', ({ repo }) => repo.findAll()),
        Effect.tap(({ overrides }) =>
          Effect.sync(() => {
            const override = overrides[0];
            expect(override).toBeDefined();
            if (override) {
              expect(Option.isNone(override.updatedBy)).toBe(true);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
    );
  });
});
