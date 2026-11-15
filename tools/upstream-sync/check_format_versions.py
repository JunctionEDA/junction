#!/usr/bin/env python3
"""Fail when upstream raised a file format version the fork's version keeper does not know.

Junction writes a file back under the version it was read with whenever the content allows
(common/io/kicad/kicad_io_utils.cpp).  That only works while every format version has an entry
in the keeper's tables; a version without one would let new tokens be written under an old
stamp.  Run from the repository root after an upstream merge.
"""
import re, sys

CHECKS = [
    ("pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.h", "SEXPR_BOARD_FILE_VERSION", "board"),
    ("eeschema/sch_file_versions.h", "SEXPR_SCHEMATIC_FILE_VERSION", "schematic"),
]
keeper = open("common/io/kicad/kicad_io_utils.cpp", encoding="utf-8").read()
missing = []
for path, macro, what in CHECKS:
    m = re.search(rf"^#define\s+{macro}\s+(\d+)\s*(?://\s*(.*))?$", open(path, encoding="utf-8").read(), re.M)
    if not m:
        missing.append(f"{macro} not found in {path}")
        continue
    version, note = m.group(1), (m.group(2) or "").strip()
    if not re.search(rf"\{{\s*{version}\s*,\s*\"", keeper):
        missing.append(f"{what} format {version} ({note}) has no entry in common/io/kicad/kicad_io_utils.cpp")
    else:
        print(f"{what} format {version}: known")
if missing:
    print("\n".join(missing))
    print("Add the version's name and the tokens it introduced to the tables in kicad_io_utils.cpp, "
          "and gate its writer with WritingOlderThan, before this merge reaches master.")
    sys.exit(1)
