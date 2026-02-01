# Changelog

All notable changes to this project will be documented in this file.

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
