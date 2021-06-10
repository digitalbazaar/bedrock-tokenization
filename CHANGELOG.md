# bedrock-tokenization ChangeLog

## 5.1.1 - 2021-06-xx

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
