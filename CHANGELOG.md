# bedrock-tokenization ChangeLog

## 5.0.0 - 2021-03-xx

### Added
- **BREAKING**: Implement new required field `levelOfAssurance` in resolve endpoint.
- **BREAKING**: Implement new required field `minAssuranceForResolution` in create endpoint.

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
