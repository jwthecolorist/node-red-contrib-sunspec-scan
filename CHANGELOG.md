# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - 2026-06-09

### Architecture

- **Single protocol module (`sunspec-client.js`)**: All addressing, decoding,
  encoding and scale-factor logic now lives in one module used by every read,
  write and scan path. This removes the duplicated, subtly-divergent copies that
  caused the addressing bugs below.
- **One source of truth**: removed the stale, divergent `src/*.ts` re-implementation
  (which `main` never ran but the tests imported) and the unused TS toolchain. The
  shipped JavaScript is now the only codebase, and the test suite runs against it.
- **Discovery + editor scans routed through the ConnectionManager**: deep scans and
  full-device reads no longer open raw sockets that could collide with runtime reads;
  they inherit the queue, connect-cooldown and hard connect-timeout protections.

### Fixed

- **Critical: Custom-List reads were off by 2 registers.** The list path used the
  model *data* address while the offset math already includes the ID+L header, so
  every value was read 2 registers too high. All paths now share one header-address
  convention. (Regression test added.)
- **Critical: Full-scan mode returned nothing.** `readSunSpecDevice` built its result
  map but never returned it, so Mode 0 always produced empty output. It now returns
  the map (and is routed through the ConnectionManager).
- **Custom-List ignored `roundDecimals`.** The list path didn't pass the node to the
  decoder, so rounding never applied. Output formatting is now consistent across modes.
- **Idle reaper could close an in-flight socket.** `lastActive` is now refreshed around
  action execution, not just on enqueue, preventing spurious "Port Not Open" during
  long scans.
- **Device names never updated once defaulted.** `upsert` now backfills a real
  manufacturer/model name over the placeholder `Device <ip>` when discovered.
- **Uncapped subnet expansion.** The `0.0.0.0/0` / subnet path now respects the same
  1000-host cap as the other range expansions, and discovery connects race a hard
  timeout so unreachable routes can't hang the editor.

### Added

- Full decode coverage for `float32`, `int64`/`uint64`/`acc64`, and `bitfield32`.
- Jest test suite (30 tests) covering offset math, decode sentinels, scaling, the
  off-by-2 regression, write encoding, IP/unit-id parsing and the device manager.

### Changed

- Removed the unused `default-browser-id` dependency.
- Added a `files` allowlist so `npm publish` ships only the runtime (no debug scripts,
  Python tooling, or committed tarballs); removed the committed `*.tgz` from the repo.
- Removed the dead, conflicting second `findModelAddress` implementation.
- Corrected the package `license` field to MIT to match the LICENSE file.
- Updated the README for 1.4.0 (read/write support, the protocol module, the Jest
  suite, the full admin endpoint list, and the 8000 ms default timeout).

## [1.2.0] - 2026-01-31

### Added

- **Human-Readable Outputs**: The node now outputs `msg.label` (e.g., "Active Power") and `msg.units` (e.g., "W") alongside the raw payload.
- **Improved Status**: Node status now displays "Label: Value Units" (e.g., "Active Power: 5000 W") instead of just the raw value.
- **Frontend Enhancement**: Configuration dropdowns now intelligently format technically named points (e.g., "DeviceName" -> "Device Name").

### Fixed

- **Critical: Port Not Open / Recursion Loop**: Fixed a critical issue where the Connection Manager would reuse a dead client reference after a fatal error, causing infinite "Port Not Open" failures. Queued requests now correctly force a reconnection.
- **Error UX**: Suppressed verbose stack traces for expected network timeouts. Timeouts are now logged as Warnings (yellow) instead of Errors (red) to keep the debug sidebar clean.
- **Write Path Crash**: Fixed an issue where writing to a point would crash the node due to a deprecated method call.
- **Write Address Offset**: Fixed a logic error where writes effectively targeted the wrong register (Header instead of Value).

## [1.1.0] - 2025-XX-XX

- Initial Release with basic SunSpec scanning and reading capabilities.
