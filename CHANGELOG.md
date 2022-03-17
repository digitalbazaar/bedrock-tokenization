# bedrock-tokenization ChangeLog

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
