# bedrock-tokenization ChangeLog

## 22.1.1 - 2025-mm-dd

### Fixed
- Return passed `record` instead of resulting record from mongodb calls to
  enable using newer mongodb driver.
- Use `result.modifiedCount`, etc. to enable newer mongodb driver.
- Remove unused `background` option from mongodb index creation.

## 22.1.0 - 2024-11-08

### Added
- Add optional feature (disabled by default) to enable lookups of pairwise
  token records by value. This is useful for applications that need to
  quickly resolve a pairwise token to an `internalId`.
- Add `tokens.resolvePairwiseToken` to resolve a pairwise token to an
  `internalId`.
- Expose `getPairwiseToken()` and `upsertPairwiseToken()` for external use.

## 22.0.0 - 2024-03-06

### Changed
- **BREAKING**: Update index on `registration.creatorHash` to compound index
  including `meta.created`. Existing deployments will need to drop the current
  index.

## 21.1.1 - 2024-02-27

### Fixed
- Ensure an expired (but still present in the database) document
  registration record will be updated when a registration attempt using
  a matching document is attempted.

## 21.1.0 - 2023-10-12

### Added
- Add `documents.getCount({query})` API which retrieves the total count of
  document records that match the specified query.
- Add an index on `registration.creatorHash` field for
  `tokenization-registration` collection.

## 21.0.2 - 2023-10-11

### Fixed
- Ensure expired pairwise tokens are refreshed and reused if they are
  found during a resolution process prior to their eviction from the
  database.

## 21.0.1 - 2023-10-10

### Fixed
- Ensure pairwise token upsert does not loop because of an expired pairwise
  token record. If an expired record has not been removed from the database
  when it needs to be used again (during an `upsert`), it will be
  auto-refreshed. External processes must remove expired pairwise token
  records if the `autoRemoveExpiredRecords` configuration option is not used
  to cause new pairwise tokens to be generated after expiration.

## 21.0.0 - 2023-10-06

### Changed
- **BREAKING**: Update peer deps:
  - Use `@bedrock/did-io@10`. This version requires Node.js 16+.
  - Use `@bedrock/tokenizer@10`. This version requires Node.js 18+.
- Update test deps.

## 20.0.0 - 2023-08-24

### Added
- Add `entities.getCount({query})` API which retrieves the total count of
  entity records that match the specified query.
- Add an index on `meta.created` field for `tokenization-entity` collection.
- Add a compound index on `entity.minAssuranceForResolution` and `meta.created`
  fields for `tokenization-entity` collection.

### Changed
- **BREAKING**: Drop support for Node.js 16.

## 19.2.0 - 2023-03-21

### Added
- Add `resolveToEntity` to ensure that when resolving a token to an entity
  that the token used, if unpinned, has not been invalidated. This helper
  function is for internal use and does not track resolution of the used
  token against a particular party. It's primary use case is for obtaining
  an entity to set its `minAssuranceForResolution`.

## 19.1.0 - 2023-01-15

### Added
- Include `validUntil` in token resolution meta data. This value indicates
  the last `Date` at which the token that was resolved will be valid.

## 19.0.0 - 2023-01-13

### Added
- **BREAKING**: Added a config option, `autoRemoveExpiredRecords`, to control
  whether expired records are automatically removed via built-in MongoDB TTL
  indexes (true = yes, false = no). This is a breaking change because the
  option is set to `false` by default, thereby preserving all records that have
  expired. Previous behavior automatically removed these records after ~24
  hours via built-in MongoDB TTL indexes. If this config option is set to
  `false` on a system where it was previously set to `true`, then any instance
  running with this configuration will NOT delete existing TTL indexes. Setting
  it to `true` on a system where it was previously `false` will result in the
  creation of new TTL indexes. These TTL indexes will result in the eventual
  removal of any records that have expired at least 24 hours ago. Note that
  upgrading a system that used a previous version will require first upgrading
  the software and then, if the configuration option is set to `false`, the
  manual removal of the existing TTL indexes.

## 18.1.0 - 2023-01-10

### Changed
- When new token batches are created for a specific entity, restrict document
  registration record refreshes to those records that match the `internalId`
  associated with the entity. Previous refreshes unnecessarily refreshed
  registration records that did not match the `internalId`.

## 18.0.0 - 2023-01-08

### Changed
- **BREAKING**: Make default token batch TTL 240 instead of 120 days.

## 17.0.0 - 2023-01-08

### Changed
- **BREAKING**: Use little-endian orders bits in the bitstrings
  used to track token resolution. This is implemented by using the default
  options via `@digitalbazaar/bitstring@3`. Any deployment using a previous
  version of this module will need to be manually migrated or drop its
  databases.

## 16.2.0 - 2022-12-17

### Added
- Add `validUntil` property in token creation results. This property
  expresses the `Date` at which the latest token will expire. Other
  returns tokens may expire sooner, but the last token in returned
  will be valid until the given `Date`.

## 16.1.0 - 2022-12-04

### Added
- Mark entity record with the token batch ID associated with the last
  failure to resolve a token due to level of assurance not being met. This
  tracking is useful in making decisions about whether to lower the minimum
  required level of assurance for an entity. For example, an application may
  opt not to lower the `minAssuranceForResolution` on an entity if its token
  batches have been invalidated since the last time a token failed to
  resolve based on assurance not being met.
- Allow full `entity` to be passed to `setMinAssuranceForResolution` to
  enable the call to return `false` if the entity's `batchInvalidationCount`
  has changed or if there is no tracked assurance-failed token resolution.
  This allows the caller to be sure that no batch invalidation events after
  the last time a token failed resolution because of a level of assurance
  that was too low.
- Allow `lastBatchInvalidationNotAfter` to be passed to
  `setMinAssuranceForResolution`. This optional parameter prevents an entity's
  `minAssuranceForResolution` from being set if its unpinned token batches
  have been invalidated after the passed `Date`. The default `Date` is set to
  be 15 minutes before system time. This check will only be run when the
  `requireAssuranceFailedTokenResolution` flag is set to `true` (which is
  also the default). When this flag is `true`, the `minAssuranceForResolution`
  will not be set unless a still-valid assurance-failed token resolution is
  found and no token batch invalidation has occurred after the specified
  `lastBatchInvalidationNotAfter` `Date`. This ensures that if a user is
  known to have provided an unpinned token that failed resolution due to
  a level of assurance that was too low -- that no other user could have
  done the same within the specified time limit.

## 16.0.0 - 2022-12-02

### Added
- Add `tokens.updateEntityWithNoValidTokenBatches` to enable setting an
  entity's `minAssuranceForResolution` and invalidating unpinned token
  batches that are in the process of being created -- if and only if the
  entity has no current valid unpinned token batches. This method provides a
  safe mechanism for updating this value only when no valid unpinned token
  batches exist even if concurrent other processes are making changes to the
  entity, including adding new unpinned token batches. The method will throw
  if the entity's state is modified from the current state and will fail
  (return `false`) if the entity has any valid unpinned token batches.

### Changed
- **BREAKING**: Default batch version option `ttl` has been changed from 60
  to 120 days. This change will not take affect in existing deployments unless
  active batch versions are updated in the database.
- **BREAKING**: Ensure batch versions cannot be created without an associated
  `tokenizerId`. It was invalid to create such batch versions before, but now
  the API enforces it.
- **BREAKING**: Allow multiple batch versions to be associated with the same
  tokenizer ID, without preventing auto-creation of a new batch version when
  tokenizer auto-rotation occurs. Existing deployments will have to manually
  remove the unique `batchVersion.tokenizerId` index to make it run properly
  with this new version.
- **BREAKING**: The default grace period for removing records that match a
  TTL index value (controlled by the option `expireAfterSeconds`) has been
  changed from `0` to 24 hours. Existing deployments must manually modify
  the registration, entity, and token batch collection TTL indexes to use
  this new value or else a conflicting index error will be thrown on startup.
- **BREAKING**: Pairwise tokens are now auto-expired via a TTL index. They
  will expire based on the TTL associated with the token (more specifically
  with that token's batch) that was most recently resolved. If a pairwise
  token already existed for a new token resolution (to the same entity and
  for the same requester but for a new token batch), then its expiration period
  will be extended to be at least as long as that new token's TTL.

### Fixed
- **BREAKING**: Prevent unpinned token batch invalidation via calls to
  `invalidateTokenBatches` from taking effect if the `entity` passed has
  a value for `minAssuranceForResolution` that does not match the value in
  the database. This ensures that concurrent changes to that value and
  to `batchInvalidationCount` are bound together and detectable.
- **BREAKING**: Ensure that entity and document registration records are
  updated (expiration period extended) when new token batches are created.
  This involves storing `externalIdHash` in entity records -- where it
  was not previously stored. Existing deployments would need users to
  resubmit document registrations to add these values to entity records
  to ensure that the new expiration extension code runs and preserves
  document registration records at least as long as the token batches
  associated with them.

## 15.0.1 - 2022-08-14

### Fixed
- Use `@digitalbazaar/minimal-cipher@5.1.1` to get chacha bug fix.

## 15.0.0 - 2022-08-01

### Changed
- **BREAKING**: Drop support for Node.js < 16. This is in accordance with the
  requirements of `@digitalbazaar/minimal-cipher@5`.
- **BREAKING**: Update peer deps:
  - `@bedrock/did-io@9`
  - `@bedrock/tokenizer@9`.

## 14.1.0 - 2022-05-10

### Added
- Return additional meta information about a resolved token from `resolve()`
  including whether it is unpinned and its `minAssuranceForResolution` at
  resolution time.

## 14.0.0 - 2022-04-29

### Changed
- **BREAKING**: Update peer deps:
  - `@bedrock/core@6`
  - `@bedrock/did-io@8`
  - `@bedrock/https-agent@4`
  - `@bedrock/mongodb@10`
  - `@bedrock/tokenizer@8`.

## 13.0.2 - 2022-04-27

### Fixed
- Ensure that the level of assurance for already-resolved, unpinned tokens
  is still checked before returning the associated pairwise token.

## 13.0.1 - 2022-04-21

### Fixed
- Do not pass database write options from config unless database
  options are modified. Future revisions will remove passing
  the options from the config entirely if determined correct.

## 13.0.0 - 2022-04-21

### Changed
- **BREAKING**: Rename package to `@bedrock/tokenization`.
- **BREAKING**: Convert to module (ESM).
- **BREAKING**: Remove default export.
- **BREAKING**: Require node 14.x.

## 12.0.0 - 2022-03-17

### Changed
- **BREAKING**: Update peer dependencies:
  - `bedrock-tokenizer@6`

## 11.0.0 - 2022-03-12

### Changed
- **BREAKING**: Update peer dependencies:
  - `bedrock-tokenizer@5`

## 10.0.0 - 2022-03-01

### Changed
- **BREAKING**: Update peer dependencies:
  - `bedrock-tokenizer@4`
  - `bedrock-did-io@6.1` (non-breaking)

## 9.2.0 - 2022-03-01

### Added
- Improve error messages in `_parseToken` helper function.

## 9.1.0 - 2022-02-24

### Fixed
- This module was erroneously requiring `bedrock-did-io` as a
  regular dependency instead of a peer dependency which can lead
  to broken behavior in some installs. This has been fixed and
  the version bumped (but both versions are compatible as long
  as they are installed as peer dependencies).

### Changed
- Use `bedrock-did-io@6` as a peer dependency. This module is still
  compatible with version 5, so this is not a breaking change, just
  a recommendation for using version 6.

## 9.0.0 - 2022-01-14

### Changed
- **BREAKING**: Update peer dependencies.
  - Update `bedrock-tokenizer` to `v3.0`.
  - Update `bedrock` to `v4.4.3`.
  - Update `bedrock-mongodb` to `v8.4.1`.
- Use `bedrock-did-io@5.0` which uses `did-veres-one@14.0.0-beta.4`.
- Remove unused package `pako`.
- Update test dependencies.

### Added
- Add missing packages `base64url-universal` and `esm`.

## 8.2.0 - 2021-11-29

### Added
- Added optional `explain` param to get more details about database performance
  for entities.
- Added database tests in order to check database performance for entities.

## 8.1.0 - 2021-11-04

### Fixed
- Fixed bug with `sort` in the `_getNextVersionId()` helper function.

### Added
- Added optional `explain` param to get more details about database performance.
- Added database tests in order to check database performance.

### Changed
- Exposed helper functions in order to properly test database calls.

## 8.0.3 - 2021-10-15

### Fixed
- Do not base64url-decode `hmac.sign` result, the API now returns a Uint8Array
  already.

### Added
- Add tests for `documents._hmacString`.

## 8.0.2 - 2021-10-14

### Changed
- Improve internal type checking in API.

## 8.0.1 - 2021-09-20

### Changed
- Simplify configuration of test suite.

## 8.0.0 - 2021-09-09

### Changed
- **BREAKING**: Updated `bedrock-tokenizer` to `v2.0.0` which nows requires a
  meter to be configured for use with the WebKMS Service.
- **BREAKING**: Added default `false` flag `allowResolvedInvalidatedTokens` to
  `resolve`. Setting this flag to true will allow already resolved but
  subsequently invalidated tokens to be resolved again.
- **BREAKING**: Updated `minimal-cipher` to `v4.0.0` which now uses
  `@digitalbazaar/x25519-verification-key-2020`, changed `@digitalbazaar/did-io`
  to `bedrock-did-io`, and removed `@digitalbazaar/did-method-key`.

### Fixed
- Added missing return value `internalId` from `resolve`.

## 7.0.2 - 2021-06-22

### Fixed
- Added `batchInvalidationCount` as a parameter to `_createBatch`.

## 7.0.1 - 2021-06-21

### Fixed
- Added `batchInvalidationCount` as a parameter to `_insertBatch`.

## 7.0.0 - 2021-06-15

### Changed
- **BREAKING**: Use latest [`cborld` v4](https://github.com/digitalbazaar/cborld/blob/main/CHANGELOG.md#420---2021-04-22)
  and `cit-context` v2.

## 6.0.0 - 2021-06-11

### Fixed
- Fix case where an entity could be updated to invalidate unpinned token
  batches but the process may crash prior (or while) updating unpinned token
  batch records to mark them as invalid. Now, unpinned token batches are
  immediately invalidated when the entity record is updated, without needing
  to update their records. The invalidation state is determined by comparing
  the monotonically increasing `batchInvalidationCount` on both the token
  batch record and the entity record, both of which always have to be
  retrieved when resolving an unpinned token anyway. So, there is no
  degradation to performance with this patch. In fact, since token batches
  no longer need to be updated with an `invalid` flag, performance is
  significantly improved in the case that batches must be invalidated because
  only one record is ever needed to be updated (the entity record). Updating
  token batch records to mark them invalid also involved a scatter-gather
  approach before so it was especially taxing; this has all been removed.

### Removed
- **BREAKING**: Remove now unnecessary index on `tokenBatch.internalId`. This
  index was used to mark unpinned token batches as invalid and another simpler
  and more robust mechanism is now used instead. The presence of this index
  in upgraded systems should not create a logic problem, however, it does
  degrade performance and take up space, so it should be removed.
- **BREAKING**: Remove `invalid` flag on token batches and replace it with the
  `batchInvalidationCount` flag copied from the entity at record creation time.

## 5.1.1 - 2021-06-10

### Fixed
- Added a fix to create entities for existing registrations. This only applies to
  versions prior to 5.0.0, since new entities are automatically created.

## 5.1.0 - 2021-05-01

### Added
- `tokens.resolve` now returns `internalId` along with existing `pairwiseToken`. While this is
  a backwards-compatible change, callers should ensure that `internalId` is not leaked beyond
  any important trust boundaries (e.g., not to the party that requested resolution).
  While this is a backwards-compatible change, callers should ensure that
  `internalId` is not leaked beyond any important trust boundaries (e.g., not
  to the party that requested resolution).

## 5.0.0 - 2021-05-05

### Added
- **BREAKING**: Implement new required field `levelOfAssurance` in resolve
  endpoint.
- **BREAKING**: Implement new required field `minAssuranceForResolution` in
  create endpoint.
- Add `minAssuranceForResolution` for token batches. This value indicates
  the minimum identity assurance level that must be provided for a token to
  be resolved. This field may be attached to a token batch (this type of batch
  is referred to as "pinned" to a particular `minAssuranceForResolution`) and
  it is set on the new primitive `entity` (see below). The value on `entity`
  will be inherited by "unpinned" token batches -- such that the tokens issued
  from these batches always use the value associated with `entity` rather than
  a "pinned" value of their own. This enables token batches to be issued to
  holders by systems/processes whereby the holder is unable to provide
  sufficient identity assurance -- but where they should be able to provide it
  later to another system/via another process. Once provided elsewhere, the
  token batches that were issued to them previously will inherit a new, lower
  required assurance allowing for more streamlined token resolution flows. This
  approach also requires the ability to invalidate any previously created
  unpinned token batches if new ones are created prior to identity assurance
  being provided. A new `tokens.invalidateTokenBatches` API enables the caller
  to invalidate these unpinned token batches prior to issuing tokens to a new
  similarly unverified holder. This ensures that these unpinned tokens will
  continue to require a high level of identity assurance until the holder
  is verified -- and that no holder that has not provided that assurance can
  use the tokens with a reduced level of assurance.
- Added new `tokenization-entity` collection. When transitioning to this new
  version, this collection should be automatically created. If you are working
  with a sharded database, this collection should be sharded on
  `entity.internalId`, which is the core and unique index for this collection.
- Added new `entities` API. This API can be used to retrieve entity records via
  the `internalId` that uniquely identifies an entity. An entity may have
  multiple registrations (each a different document) that are all bound by
  `internalId`. A call to `entities.setMinAssuranceForResolution` will set
  the `minAssuranceForResolution` associated with an entity. This value will
  be inherited by "unpinned" token batches and it will not affect "pinned"
  token batches.

### Changed
- **BREAKING**: Calls to `tokens.create` require a previous call to
  register the entity associated with `internalId` or parameters
  `registerPromise` and `newRegistration` that indicate a registration is
  being performed concurrently.

### Removed
- **BREAKING**: Removed `tokenization-openTokenBatch` collection. In order
to transition to this new version, this collection can be safely dropped.

## 4.0.1 - 2021-03-18

### Fixed
- Remove duplicate conditional in the `documents.register` API.

## 4.0.0 - 2020-11-03

### Changed
- Use cborld@2.0.1.

### Added
- Implement `recipientChain` param for `documents.register()`.
- Implement `documents.getRegistration()`.

## 3.0.1 - 2020-09-28

### Changed
- Update peer deps.

## 3.0.0 - 2020-09-28

### Changed
- **BREAKING**: Changed format for storing token resolutions.
- **BREAKING**: Use BinData for storing IDs, hashes, and bit strings.
- Use did-method-key@0.7.0.

## 2.0.0 - 2020-08-24

### Changed
- **BREAKING**: Updated CIT context, add Ed25519Signature2020 cryptosuite.

## 1.0.0 - 2020-08-19

### Added
- Added core files.
- See git history for changes.
