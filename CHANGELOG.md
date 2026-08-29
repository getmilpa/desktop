# Changelog

All notable changes to Milpa Desktop are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- Live preview pane: type the name of a screen the agent declared (`screen:declare`) and see it rendered.
- Cross-platform launcher (`run-desktop.sh`) that pulls the public image and seeds demo screens.
- Checksummed build (`build-desktop.sh`) and a CI workflow that builds Linux + macOS distributables with
  `SHA256SUMS.txt` on a `desktop-v*` tag.
- i18n (English default, Spanish selectable).

_Extracted into its own public home as a client of the framework._
