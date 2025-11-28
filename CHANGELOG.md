# @h7/importmap-esbuild-plugin Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [unreleased]

### Fixed

- Prefix import map keys (ending in `/`) are now required to map to values that also end in `/`, matching the HTML import map spec.
   - Previously, such mappings would be accepted and could result in confusing behavior.

## [0.1.1] - 2025-11-27

### Fixed

- Fix default export

## [0.1.0] - 2025-11-27

- Initial code

[unreleased]: https://github.com/harmony7/importmap-esbuild-plugin/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/harmony7/importmap-esbuild-plugin/compare/v0.1.0...0.1.1
[0.1.0]: https://github.com/harmony7/importmap-esbuild-plugin/releases/tag/v0.1.0
