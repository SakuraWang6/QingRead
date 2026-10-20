# Contributing

Use Node.js 24 for `web/`, run `npm ci`, `npm test`, and `npm run build`. Swift core tests use `swift test` or `bash scripts/verify-core.sh`; the iOS UI needs full Xcode. Do not enable live source tests by default; they depend on external sites.

Keep source URLs and content attribution intact. Do not add credentials, downloaded copyrighted books, signing identities or user data. New sync changes should preserve the shared Swift/TypeScript fixture and account-isolation tests. Describe observable behavior and validation in pull requests.

Android public CI produces debug validation APKs. For upgradeable private distribution, maintain your own persistent signing identity outside this repository.
