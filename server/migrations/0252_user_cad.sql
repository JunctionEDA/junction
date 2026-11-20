-- Mechanical CAD (part studios, assemblies, the board link) is a setting each person turns on for themselves.
-- Off by default: a person who leaves it off gets the PCB application without CAD (GET /api/me "cad",
-- PUT /api/me/cad).  Only the interface and the MCP tool list follow it; documents are never refused or hidden.
ALTER TABLE users ADD COLUMN cad_enabled boolean NOT NULL DEFAULT false;
