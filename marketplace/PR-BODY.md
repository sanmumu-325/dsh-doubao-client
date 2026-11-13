## Add sanmumu-325/dsh-doubao-client

Adds one `model` entry at `data/plugins/sanmumu-325__dsh-doubao-client.yml`. The market's generated READMEs and unrelated entries are unchanged.

### What the plugin does
- Registers the signed-in local Doubao Windows client's catalog as a DSH model provider, using ordinary chat mode only.
- Provides real subscription quota queries and a metadata-only local usage ledger; character estimates remain separate from real token usage.
- Supports image input on verified routes and strict-JSON DSH tool-call emulation (not native functions/tools).
- Adds bounded cross-session concurrency, default 2; same-session continuation remains serial.
- Provides a first-use wizard with read-only discovery, verified local executable/port ownership, explicit launch consent, and optional on-demand auto-start (off by default). No client is killed or restarted automatically.

### Safety and limitations
- Unofficial integration requiring the user to install, sign in to, and explicitly expose a literal-loopback debugging port on Doubao Desktop.
- Local connection does not mean local inference: DSH system instructions, transcript and tool schemas are sent to Doubao, and image attachments use Doubao's own cloud upload channel.
- No credential export, native Doubao task runtime, sandbox execution, automatic login, retries or risk-control bypass.
- Historical 1.3.x probes covered text on 12 catalog entries and image reading on 10; those are not guarantees of current vendor availability.
- 1.8.0 includes offline coverage for bounded concurrency, startup consent, path/publisher verification, revocation and setup-route validation. The release verification report records the final test count and runtime/UI checks. Real client restart, fresh login and simultaneous upstream generations were not exercised as part of onboarding development.

### Installability
- Root package: `@sanmumu/dsh-doubao-client`, version `1.8.0`, Node.js 22+.
- `dsh.bundle.patch` points to `cordis.patch.yml`; client module id equals the package name.
- Plain JavaScript; no runtime third-party dependencies or install/build scripts.
- Original SVG icon and MIT license included.

### Author checks before opening this PR
- Publish the source repository at the entry URL and add the `dsh-plugin` topic.
- Check the repository satisfies the market's minimum repository-age requirement (the saved contribution guide specifies one day; recheck before submitting).
- Publish the npm package or upload the prebuilt tarball to a GitHub Release before claiming that public installation is available.
- Check this entry against the then-current `contributing.md`.

This file is a prepared PR body, not evidence that a public repository, npm release or market PR already exists.
