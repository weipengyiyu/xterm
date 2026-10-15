# Bundled RustDesk client

This directory contains the unmodified official RustDesk 1.5.0 Windows x64
portable executable. It is a separate application launched by xterm.

- Upstream: https://github.com/rustdesk/rustdesk
- Release: https://github.com/rustdesk/rustdesk/releases/tag/1.5.0
- Original asset: `rustdesk-1.5.0-x86_64.exe`, renamed to `rustdesk.exe`
- Download: https://github.com/rustdesk/rustdesk/releases/download/1.5.0/rustdesk-1.5.0-x86_64.exe
- SHA-256: `8555777215510d83d2d61c9dc984e4fcc838bd7e79f9d18a42585431f5e8bb47`
- Copyright: RustDesk contributors; retain upstream copyright and dependency notices.
- License: GNU Affero General Public License, version 3; see `LICENSE`.

Source materials are provided alongside the executable:

- `source/rustdesk-1.5.0.tar.gz`: upstream commit
  `fada664df7a294d1d1a9ca3e7cd3637069122f17` (release tag `1.5.0`).
  https://github.com/rustdesk/rustdesk/tree/fada664df7a294d1d1a9ca3e7cd3637069122f17
- `source/hbb_common-229b904.tar.gz`: the release's `libs/hbb_common` submodule,
  commit `229b904508364c8997aad0fb5af57effac859f60`.
  https://github.com/rustdesk/hbb_common/tree/229b904508364c8997aad0fb5af57effac859f60

To prepare the source tree, extract the RustDesk archive, then extract the
hbb_common archive into its `libs/hbb_common` directory (removing the archive's
top-level directory). The RustDesk source archive includes dependency manifests,
lockfiles, build scripts and `.github/workflows/flutter-build.yml`. Follow those
upstream build instructions; dependency downloads and platform build tools are
needed to build RustDesk. These archives are distribution/source materials, not
dependencies of xterm's runtime.

Keep the executable, license, this notice, manifest and source archives together
when distributing this directory. A bundled portable client does not register
a Windows service or enable unattended access automatically. xterm launches it
when the user connects a RustDesk session. The Settings > RustDesk service
switch can explicitly install the client into the system directory and enable
its Windows service after administrator approval. Disabling that switch stops
the service and disables automatic startup; it preserves the installation.

To update the bundled version, replace the executable and matching source
archives from an official upstream release, retain its license/notices, and
update `manifest.json` with the version, source commits, URLs, sizes and hashes.
Run `npm run test:rustdesk` and rebuild the portable package. Alternatively,
select an independently installed client explicitly in the xterm session.
