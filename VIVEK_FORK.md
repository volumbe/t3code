# Vivek desktop build

This fork keeps the upstream T3 server protocol. The first UI change removes
the empty Add action button, Open, and Git actions from the chat header. It
also hides the terminal drawer toggle there. The header change does not alter
the underlying server operations or terminal keyboard shortcut.

## Mac app

The packaged app is `T3 Code (Vivek)` with bundle ID `com.volumbe.t3code`.
It stores its desktop state in `~/.t3-vivek/userdata` and its Electron data in
`~/Library/Application Support/t3code-vivek`. It does not register as the
macOS handler for `t3code://` links, so the upstream app can stay installed.
The local build has no automatic update feed. Rebuild it when this fork moves
to a newer upstream release.

The Mac app icon and the client logo use the Office handshake from Nextcard.
The source files are copied from `apps/office/public/icons/office-512.png` and
`apps/office/public/affil-icon.svg` in that repository. Refresh both copies
when the Office logo changes.

Install dependencies with `vp i`. Build the macOS app at the release version
used by the connected Ubuntu server:

```sh
PATH="$PWD/node_modules/.bin:$HOME/.cargo/bin:$PATH" \
  env -u GITHUB_REPOSITORY -u T3CODE_DESKTOP_UPDATE_REPOSITORY \
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version 0.0.42
```

The DMG and ZIP go to `release/`. Quit the fork before replacing it. To install
the ZIP on this Mac:

```sh
ditto -x -k release/T3-Code-Vivek-0.0.42-arm64.zip /Applications
codesign --force --deep --sign - '/Applications/T3 Code (Vivek).app'
codesign --verify --deep --strict '/Applications/T3 Code (Vivek).app'
```

The local app uses an ad hoc signature. Distribution to another Mac requires
Apple signing and notarization. On first launch, turn off the local environment
in Settings > Connections, then pair the private `ubuntu` environment. The
fork has separate saved connections and needs its own pairing. Do not copy
credentials between the two apps. This Mac's local environment was turned off
before first launch.

## Taking upstream releases

Keep `origin` pointed at `volumbe/t3code` and `upstream` at
`pingdotgg/t3code`. Merge each stable upstream release tag into `main`,
resolve any conflicts in this small customization, then rebuild with that
release's version. Update the private Ubuntu T3 service to the matching
version during a quiet period, using the procedure in the machine repository's
`ubuntu/t3code-vivek-affil/README.md`. Do not update the Office T3 service
as part of this workflow.
