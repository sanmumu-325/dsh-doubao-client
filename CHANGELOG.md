# Changelog

## 1.8.0 — 2026-11-14

### First-use setup
- A localized settings wizard provides read-only path discovery, manual path selection, explicit local-debugging consent, one-click launch and revocation.
- Optional on-demand auto-start is off by default and requires saved consent. Installation, settings refresh, catalog listing and the model-facing status tool never start the client.
- Client startup uses native process launch without a shell or a user-run PowerShell script. The client window may still appear or take focus.
- Windows discovery checks running processes, install records and bounded common paths; executable signature/publisher, path/reparse safety, port ownership and the Doubao chat target are verified before startup/reuse. Unknown ownership or an already-running client without the channel fails closed; no kill/restart/login/risk-control bypass.
- Setup preferences contain only executable path and launch consent/auto-start, stored locally outside the package. No credentials or user preferences are shipped in release artifacts.
- A separate authenticated, same-origin setup route handles explicit management actions; the existing status tool remains read-only.

### Verification boundaries
- New startup and consent logic is covered by injected offline tests; no real client was stopped/restarted and no real startup permission was enabled during development.
- Final test counts and actual settings-page verification are recorded in the release verification report. No additional upstream model requests are required to test onboarding.

## 1.7.0 — 2026-11-14

### Added
- Bounded cross-session concurrency: default 2 slots, configurable from 1 to 8. A FIFO queue waits up to `busyWaitMs` (default bundle setting: 20 seconds).
- Request-owned channel leases shared by streams and identity/metadata reads. Same-session generation remains serial to protect upstream continuation.
- Status exposes active, queued, maximum and quarantined slots, plus in-flight/quarantined session counts.

### Fixed
- Cleanup is memoized and same-session unlock waits for downstream teardown.
- Abandoned output cannot resume and overwrite a newer completed turn. Continuation commits are fenced against account changes, invalidation and superseding plans.
- Unconfirmed remote termination quarantines both channel capacity and the affected session instead of blindly starting replacements.
- Account identity is checked for image/auxiliary calls and around asynchronous image uploads. Renderer registry deletion runs even if cancellation throws.
- Release documentation and localized descriptions now match the implemented ordinary-chat routing and concurrency behavior.

### Verification and limits
- 150 offline regression tests passed before this release; they do not send model requests or consume subscription quota.
- Installed runtime status verified version 1.7.0 with `maxConcurrent: 2`. Two concurrent upstream model generations were not live-tested for this release because earlier probes encountered vendor risk control.
- Historical 1.3.x probes verified text access for 12 catalog entries and image reading on 10. These results are not a guarantee of current vendor availability, rate limits, or usable context capacity.
- No native Doubao task runtime, sandbox, cookie export, automatic login, retry or long-document attachment experiments are included.

## 1.6.4
- Short bounded wait for channel/session contention rather than unconditional immediate failure.

## 1.6.3
- Abandoned-consumer watchdog and channel occupancy reporting.

## 1.6.2
- Apply the local prompt character limit to the actual transmitted full history or safe continuation delta, while structurally validating the entire history.

## 1.6.0–1.6.1
- Strict same-account, same-session, matching-prefix continuation; separate context-window telemetry and explicit risk-control classification.
- Removed the context telemetry settings card while retaining backend telemetry and risk notices.
