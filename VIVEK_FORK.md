# T3 Work

This fork keeps the upstream T3 server protocol, so it connects to an
unmodified T3 server of the same version. All changes are in the desktop and
web client.

## Code and Work modes

The sidebar brand ("T3 Code" / "T3 Work") is a menu that switches modes. The
choice is stored locally under `t3work:work-mode:v1`.

- **Code** is upstream T3 Code: project sidebar, terminal, actions, Open in,
  and Git controls.
- **Work** hides coding controls: the header's actions, Open in, and Git
  controls; the terminal toggle, drawer, and shortcuts; the diff shortcut; the
  branch and worktree selectors; Pull Requests; and the terminal, diff,
  pull request, and device surfaces in the right panel. Its sidebar is a folder
  tree (`apps/web/src/components/work/WorkSidebar.tsx`). Folders are
  client-side only: they record which folder each `environmentId:threadId` is
  filed in and do not change server threads. Deleting a folder moves its
  chats and subfolders up one level.

In both modes, the right panel's **Chat** surface shows another chat from the
same project beside the main thread
(`apps/web/src/components/work/DockChatPanel.tsx`). It can start a new chat or
open an existing one. It is a compact transcript and composer, not a second
`ChatView`, because `ChatView` owns window-wide shortcuts and route-driven
draft state. Approvals and questions are answered in the main view.

## Mac app

The packaged app is `T3 Work` with bundle ID `com.volumbe.t3code`. Earlier
builds were named `T3 Code (Vivek)`; the rename keeps the same bundle ID and
data directories, so saved connections carry over.
It stores its desktop state in `~/.t3-vivek/userdata` and its Electron data in
`~/Library/Application Support/t3code-vivek`. It does not register as the
macOS handler for `t3code://` links, so the upstream app can stay installed.
The local build has no automatic update feed. Rebuild it when this fork moves
to a newer upstream release.

The Mac app icon uses the Virtual Office `VO` monogram from Nextcard's
`apps/office/src/features/app-shell/office-mark.tsx`. Its vector source is
`assets/vivek/office-vo-macos.svg`. Regenerate the PNG after changing the SVG:

```sh
sips -s format png assets/vivek/office-vo-macos.svg \
  --out assets/vivek/office-vo-macos-1024.png
```

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
ditto -x -k release/T3-Work-0.0.42-arm64.zip /Applications
codesign --force --deep --sign - '/Applications/T3 Work.app'
codesign --verify --deep --strict '/Applications/T3 Work.app'
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
