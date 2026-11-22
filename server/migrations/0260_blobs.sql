-- Stored files, kept once.  A snapshot used to carry its whole file (`snapshots.content`), so a copied,
-- cloned or branched project, every account's Devboard Demo and every snapshot of a slowly changing board
-- stored the same bytes again.  A snapshot now points at a blob (`snapshots.blob`), named by the SHA-256 of
-- the file it stands for, so identical files are stored once, and the bytes are zstd-compressed by the
-- server (src/blobs.rs):
--   enc 1  the whole file, compressed
--   enc 2  the file as a difference from `base` (another blob, always enc 1), compressed
-- Rows written before this still carry `content`; the server reads either and moves old rows over on
-- request (admin page, "Compact storage"), checking every file byte for byte before the old copy goes.
CREATE TABLE IF NOT EXISTS blobs (
    hash       BYTEA PRIMARY KEY,
    size       BIGINT NOT NULL,
    enc        SMALLINT NOT NULL,
    base       BYTEA REFERENCES blobs(hash),
    data       BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((enc = 1 AND base IS NULL) OR (enc = 2 AND base IS NOT NULL))
);
-- already compressed: Postgres need not try again
ALTER TABLE blobs ALTER COLUMN data SET STORAGE EXTERNAL;
CREATE INDEX IF NOT EXISTS blobs_base_idx ON blobs (base) WHERE base IS NOT NULL;

ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS blob BYTEA REFERENCES blobs(hash);
ALTER TABLE snapshots ADD COLUMN IF NOT EXISTS size BIGINT;
ALTER TABLE snapshots ALTER COLUMN content DROP NOT NULL;
ALTER TABLE snapshots ADD CONSTRAINT snapshots_stored CHECK (content IS NOT NULL OR blob IS NOT NULL);
CREATE INDEX IF NOT EXISTS snapshots_blob_idx ON snapshots (blob) WHERE blob IS NOT NULL;
