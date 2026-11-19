# server/web: the browser app

TypeScript and React, bundled by esbuild into `server/static` (`npm run build`; the entry points are in
`server/package.json`). The tree has three areas:

```
web/
  main.tsx            the React chrome's entry (static/dist/ui.js)
  shared/             used by every area: the store contract, theme, keys, units, menus, the UI kit, styles
    components/       menu bar, toolbars, docks, panes, selects, dialogs' widgets
    styles/           the Tailwind entry and home.css
  platform/           what every kind of project shares
    home/             projects list, upload, sharing (ShareDialog), time page
    landing/          the public home page and its demos
    onboarding/       first-run guide
    github/           GitHub sync
    review/           version compare and review
    wakatime/         time tracking
    admin/, styleguide/
  domains/            one folder per kind of design work
    registry.ts       what each domain is, which files it opens and which domains it reads
    pcb/              electronics: schematic, symbols, board, footprints, fab, simulation (shipped)
    mechanical/  assembly/  physics/  silicon/  robotics/  manufacturing/   (planned)
```

Rules of thumb:

- `shared/` and `platform/` should not grow new imports from `domains/`. Some imports already go that way (the
  chrome mounts the electronics editor's menus and toolbars, and `platform/review` diffs KiCad documents). Untangling
  them is on the roadmap. Don't add more.
- A domain may import from `shared/` and `platform/`, but never from another domain's internals. Share through
  `shared/` or the domain's documented exports instead.
- Files under `domains/pcb/generated/` are written by `server/scripts/gen_*.py` from the C++ sources. Don't edit
  them by hand.

The tests in `server/static/tests` find modules with `webPath()` (`static/tests/web-path.js`), which knows
which area each top-level folder lives in.

See [STYLE.md](STYLE.md) for how the chrome is written, and [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md)
for the whole repository.
