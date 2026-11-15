# Changelog

Releases of Junction, which was called KiCad Collaborative up to 1.0.9. The
version here is the product version (`packaging/VERSION`), not the KiCad
version it is based on.

## Unreleased

### Desktop
- The library download says what it is fetching, how much of the whole it
  has and how long it still takes ("Downloading symbols: 21 of 61 MB, about
  40 s left"), short enough to read in the editors' status bar too.
- A 3D model fetched for the viewer is kept for good: it is saved into the
  library folder on this computer (3dmodels/<Library>.3dshapes, beside the
  downloaded symbols and footprints), so it is downloaded once and is there
  for every project afterwards. Models fetched by earlier versions are moved
  over the first time they are used.

## 2.1.3 (2026-11-15)

### Desktop
- Works on a computer with no KiCad installed: when no symbol or footprint
  libraries are found, Junction offers to download the standard KiCad
  libraries and project templates (about 60 MB) and uses them at once, without a restart.
  Preferences, Download Standard Libraries does the same later.
  The archives come from the Junction server (checked against their
  SHA-256, and continued in the middle of a file after an interruption) and
  from the KiCad library repositories when it cannot deliver.
  A download cut short by closing Junction, sleep or a lost connection
  continues at the next start from what it already has; a failed connection
  is retried by itself until it works (waiting up to a minute between
  tries).
  The download runs in the background, so you keep working while it runs:
  the status bar of the project manager and of the editors shows how far it
  is, the notifications say when it starts and when the libraries are ready,
  and Preferences, Download Standard Libraries shows the progress with Try
  Now and Stop Download. Until the download has finished its symbols and
  footprints are not in the choosers (the editor says so), and they appear
  there by themselves afterwards.
- The project manager program itself is named Junction on every system
  (Junction inside the Mac app, junction.exe on Windows, Junction on Linux
  with a Junction desktop entry and icon), so Activity Monitor, Task Manager
  and system messages say Junction instead of kicad. Settings stay where
  they were.
- Changes an assistant proposes through the MCP server now show in the board
  and schematic editors: a bar names the proposal with Show (draws it over the
  design), Details, Accept and Reject, and File, Proposed Changes brings it
  back. An accepted proposal lands as one edit that undo takes back.
- An assistant's highlight shows its note under its name tag.
- A project that came online without its footprint library folders gets them
  written back from its boards when it is opened, the way Export Footprints to
  Library does, so the rules check no longer warns "footprint not found in
  library" for every part. The next sync stores them with the project.
- 3D viewer: standard library models that are not on this computer are
  fetched several at a time before the board's parts are loaded, instead of
  one by one. A cached file that is not a model is fetched again.
- Publishing a project that is larger than an online project can hold says so
  before anything is sent.
- The message that a local copy went to Junction's own data folder has a
  button that shows the folder.

### Web
- 3D viewer: the parts named in the status line (closest model used, plain
  shape) are links that select the part on the board.
- Footprint editor, Footprint Properties, 3D Models: Use Closest Library Model
  finds the model in KiCad's 3D library that comes closest to the footprint.
- Vendor parts: stock and price say which vendor they are from.
- Opening a schematic no longer raises a page error that stopped the other
  sheets' nets from being read.
- Upload: when a project names libraries or 3D models of its own that were
  not among the uploaded files, the upload dialog lists them and takes the
  missing files or the project folder to add them.
- One file of an online project can now be 200 MB (was 30 MB) and a project
  500 MB (was 100 MB). Uploads are written to disk as they arrive instead of
  being held in memory. A file or project over the limit is refused before
  the upload starts, with its size and the limit; saving a document that
  large no longer fails at 50 MB.

### Checks
- A "Loads in desktop" run on every server change makes a blank project,
  every template, and demo projects downloaded with rebuilt libraries and
  after edits, and opens each file with the desktop's own reader.

### Downloads

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon, macOS 15+) | `Junction-2.1.3-macos.dmg` | Ad-hoc signed: first launch is right-click, Open. Replace the old app in Applications. |
| Windows x64 | `Junction-2.1.3-windows-x64.exe` | Installer; upgrades earlier versions in place. |
| Linux x64 (Ubuntu 24.04 LTS) | `Junction-2.1.3-linux-x64.tar.gz` | Extract anywhere, install the packages listed in `usr/share/junction/ubuntu-packages.txt` (`sudo apt install $(cat usr/share/junction/ubuntu-packages.txt)`), run `usr/bin/junction`. |

## 2.1.2 (2026-11-15)

Desktop fixes found by opening online projects end to end, and 3D models that
show without a KiCad installation.

### Desktop
- 3D viewer: a standard library model that is not on this computer is fetched
  from the server once and kept in the user cache, so boards show their parts
  without KiCad's 3D library installed. When KiCad's library has no model
  under that name, the closest one is used. A part whose model cannot be had
  at all is drawn as a generic box instead of bare pads.
- An online project whose footprint library table names an empty project
  library no longer reports "Footprint library ... not found" on every open.
- A project that was uploaded without its project symbol library gets the
  library written back from the schematic's own copies of the symbols when it
  is downloaded.
- When the projects folder cannot be written (macOS not allowing Documents),
  the local copy of an online project goes to Junction's own data folder and a
  message says where, instead of the download failing.
- The browser page shown after signing in has Junction's look and a button to
  close the tab.
- A font whose licence forbids embedding is reported once per project, not on
  every open.
- When the server refuses an upload (a file over the size limit), the message
  says why.

### Web and assistant
- The 3D view shows the closest library model for a part whose own model is
  missing, looks up a model by the footprint's name when the footprint names
  none, and says in the status bar which parts were replaced.
- New edit `assign_models` and harness call `board.assign_models()` write the
  closest model into the footprint.

### Downloads

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon, macOS 15+) | `Junction-2.1.2-macos.dmg` | Ad-hoc signed: first launch is right-click, Open. Replace the old app in Applications. |
| Windows x64 | `Junction-2.1.2-windows-x64.exe` | Installer; upgrades earlier versions in place. |
| Linux x64 (Ubuntu 24.04 LTS) | `Junction-2.1.2-linux-x64.tar.gz` | Extract anywhere, install the packages listed in `usr/share/junction/ubuntu-packages.txt` (`sudo apt install $(cat usr/share/junction/ubuntu-packages.txt)`), run `usr/bin/junction`. |

Symbol and footprint libraries are not bundled; point the library tables at an existing KiCad 10 install.

## 2.1.1 (2026-11-15)

A small desktop fix on top of 2.1.0.

### Desktop
- Opening an online project into a folder Junction may not write to (for
  example Documents on macOS before you allow it) now stops with one message
  that names the folder and says how to allow it. Before, the download left an
  empty folder and a list of "can't open file" errors.

### Downloads

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon, macOS 15+) | `Junction-2.1.1-macos.dmg` | Ad-hoc signed: first launch is right-click, Open. Replace the old app in Applications. |
| Windows x64 | `Junction-2.1.1-windows-x64.exe` | Installer; upgrades earlier versions in place. |
| Linux x64 (Ubuntu 24.04 LTS) | `Junction-2.1.1-linux-x64.tar.gz` | Extract anywhere, install the packages listed in `usr/share/junction/ubuntu-packages.txt` (`sudo apt install $(cat usr/share/junction/ubuntu-packages.txt)`), run `usr/bin/junction`. |

Symbol and footprint libraries are not bundled; point the library tables at an existing KiCad 10 install.

## 2.1.0 (2026-11-14)

A desktop update with new features since 2.0.0. It reads and writes the same
files as 2.0.0, so people in a project can update one at a time.

### Desktop
- Online Projects is a docked pane in the project manager instead of a modal
  dialog: shown by default, toggled from the left toolbar, View > Panels and
  File > Online Projects. A This Project card says whether the open project is
  local only or synced, with its live session state.
- WakaTime: the editors send heartbeats like WakaTime's own plugins, set up in
  Preferences > Common > WakaTime. Works with WakaTime, Hackatime, Wakapi or any
  WakaTime-API server, reads and keeps `~/.wakatime.cfg`, and uses wakatime-cli
  when it is installed.
- Fonts: every Google Font is in the font list and downloads when picked; a
  font missing on this computer is fetched while the app runs and the text is
  redrawn without a restart. Fonts only you have are shared with the project so
  collaborators draw the same letters, and stored glyph outlines are kept on
  load and on copy.
- Collaborator cursors are bigger, with a filled name tag.

### Files
- Saving keeps KiCad 9 and 10 boards and schematics readable by KiCad 9 and 10.
  Fixed: boards with a layer stackup were raised to a newer format, KiCad 9
  boards were written with nets by name, zones lost their fill thickness flag,
  teardrops lost their ids and old plot layer selections were renumbered.
- A file stamped by a newer KiCad opens when everything in it is known; an
  unknown construct still stops the load, so nothing is dropped silently.
- No more notice when an older KiCad file opens, since it is saved back at its
  own version.

### Web editor and server (already live)
- Many more KiCad dialogs and tools in the browser: Board Setup with an editable
  stackup, Zone Manager, Teardrops, Cleanup Graphics, Remove Unused Pads,
  Geographical Reannotate, Repair Board, Net Inspector, hierarchy-wide ERC,
  inter-sheet references, KiCad's menu bars, mouse and touchpad preferences.
- WakaTime heartbeats from the browser editor, GitHub sync through the
  "KiCAD Junction" GitHub App, and router and placement improvements for
  AI-designed boards.

### Packaging
- The macOS DMG is now built in CI with Windows and Linux, and every release
  run installs and launches all three builds on clean machines before it
  publishes.
- The Linux tarball runs from wherever it is extracted (2.0.0 looked for its
  libraries and data under /usr), and lists the Ubuntu packages it needs in
  `usr/share/junction/ubuntu-packages.txt`.

### Downloads

| Platform | File | Notes |
|---|---|---|
| macOS (Apple Silicon, macOS 15+) | `Junction-2.1.0-macos.dmg` | Ad-hoc signed: first launch is right-click, Open. Replace the old app in Applications. |
| Windows x64 | `Junction-2.1.0-windows-x64.exe` | Installer; upgrades 2.0.0 or KiCad Collaborative in place. |
| Linux x64 (Ubuntu 24.04 LTS) | `Junction-2.1.0-linux-x64.tar.gz` | Extract anywhere, install the packages listed in `usr/share/junction/ubuntu-packages.txt` (`sudo apt install $(cat usr/share/junction/ubuntu-packages.txt)`), run `usr/bin/junction`. |

Symbol and footprint libraries are not bundled; point the library tables at an existing KiCad 10 install.

## 2.0.0 (2026-11-12)

First release since 1.0.9. It is a major version because the desktop app is
now built on a much newer KiCad (2782 upstream commits, through 2026-11-10),
so a 2.0 client can write things into a shared project that a 1.0.9 client
cannot read. Everyone in a project should update together. Files you open
still keep the format version they came with unless an edit needs a newer one.

### New name
- KiCad Collaborative is now Junction. The app, the installers, the web editor
  and the repository (github.com/notaroomba/junction) carry the new name. Your
  settings, sign-in, online projects and the kicad-collab:// links are unchanged.

### Web editor
- The browser editor went from a viewer to a full editor that follows KiCad's
  own tools and dialogs: schematic and board editing, the interactive router
  (drag, differential pairs, length tuning), zones and zone fill,
  DRC and ERC, custom rules, Properties panel, context menus and hotkeys.
- Symbol Editor and Footprint Editor, with library management, the Footprint
  Wizard and KiCad library access (Choose Symbol / Choose Footprint).
- Fabrication outputs from the browser: Gerbers, drill files, placement, BOM
  and plots, checked against kicad-cli on the demo boards.
- 3D viewer, SPICE simulation with ngspice, and the Simulation Model Editor.
- Board autorouter (Route > Autoroute) with differential pairs, impedance from
  the stackup, length matching, signal domains and ground via fences.
- Vendor parts: search LCSC, Mouser and DigiKey and place the symbol and
  footprint, with saved part libraries.
- Plugins: a Plugin Manager with one catalog for built-in, KiCad and community
  plugins, sandboxed and permissioned, including KiCad IPC and Python plugins.

### Projects, sharing and history
- Stored online projects with a web home: blank projects, starter templates,
  stars, Trash and public projects.
- Roles and sharing: a comment-only role, view and comment links that open
  without an account, and per-project permissions.
- Version history and branches on the server, and a visual compare of versions.
- Design review: comment threads pinned to parts and nets.
- GitHub repository sync for online projects: connect, import, push, pull and
  an item-level merge that shows what changed inside each file.

### Desktop
- Merged upstream KiCad master. About says "based on KiCad 10".
- Keep working offline and merge when the connection comes back.
- The History panel lists versions and follows them live, and File has
  Compare Versions.
- Comment threads carry their part or net and their pins follow it.
- Presence carries each selected item's anchor, so a peer's drag is ghosted at
  the exact offset.
- One folder syncs with one online project.
- Fixed two crashes when a tuning pattern is regenerated.

### AI and scripting
- MCP server: any AI model or service that speaks MCP can open, read and edit
  your online projects, with consent and the project's roles enforced.
- Python harness: design by script (`run_python` over MCP) with live drawing,
  schematic blocks drawn like a datasheet application circuit, board routing,
  zones, keepouts and layout checks.
- The in-editor chat is gone. An assistant works on a project through MCP.

### Packaging
- Windows and Linux builds need glslang, spirv-tools, the Vulkan headers and
  SQLite now (upstream's new renderer and database library backend). macOS
  also needs spirv-cross.

## 1.0.9 (2026-09-19)

Wires, symbols and fields sync and preview correctly between two desktop
clients. See the GitHub release for the full notes.
