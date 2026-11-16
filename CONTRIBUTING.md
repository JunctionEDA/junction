# Contributing to Junction

Thank you for helping. Junction is a fork of KiCad with live collaboration, a web editor and a
server; it is not part of the KiCad project, so please bring Junction issues and changes here
rather than to KiCad's GitLab.

## Where things live

| Part | Path | Language |
| --- | --- | --- |
| Desktop app (KiCad plus collaboration) | `common/collab`, `eeschema/collab`, `pcbnew/collab`, and the rest of the KiCad tree | C++ |
| Server | `server/src` | Rust |
| Web editor | `server/web` (generated bundles in `server/static`) | TypeScript |
| Upstream KiCad sync | `tools/upstream-sync`, `.github/workflows/upstream-sync.yml` | Python, shell |

## Ground rules

- **The web editor behaves like KiCad.** KiCad's own behaviour and code are the spec for every
  interaction and visual detail. Point at the KiCad source a change follows.
- **Edit TypeScript, not generated files.** `server/static/*.js` and `server/static/dist/*` are
  built by `npm run build` in `server/`; tables in `server/web/generated/` come from
  `server/scripts/gen_*.py`.
- **Never raise a file format version a file does not need.** A file read at an older KiCad
  version is written back at that version whenever its content allows
  (`common/io/kicad/kicad_io_utils.cpp`); new tokens must be gated with `WritingOlderThan`.
- **Keep KiCad's code as it is where you can.** Every line changed in an upstream file is a
  possible merge conflict in the weekly sync; put new behaviour in new files and small hooks.

## Before sending a change

```sh
cd server
npm ci
npm run check     # type check; a failure blocks every deploy
npm run build
npm test
```

For desktop changes, build with `-DKICAD_BUILD_QA_TESTS=ON` and run the collaboration and file
format suites (`CollabSync`, `PcbCollabSync`, `CollabProjectRegistry`, `CollabFonts`,
`SchematicFormatRoundTrip`, `BoardFormatRoundTrip`).

C++ follows [KiCad's code style](https://dev-docs.kicad.org/en/rules-guidelines/code-style/)
(`_clang-format` is in the root).

## License

Contributions are accepted under the [GPLv3](LICENSE), like KiCad.
