-- CAD and multi-file project documents moved out of the PCB application.
CREATE TEMP TABLE junction_cad_docs ON COMMIT DROP AS
SELECT id FROM documents
WHERE doc_type IN ('part_studio', 'assembly', 'project_shell')
   OR path ~* '\.(jpart|jasm|jproj)$';

CREATE TEMP TABLE junction_cad_versions ON COMMIT DROP AS
SELECT DISTINCT version_id FROM version_docs
WHERE doc_id IN (SELECT id FROM junction_cad_docs);

DELETE FROM activity_beats WHERE doc_id IN (SELECT id FROM junction_cad_docs);
DELETE FROM project_github_files
WHERE doc_id IN (SELECT id FROM junction_cad_docs)
   OR path ~* '\.(jpart|jasm|jproj)$';
DELETE FROM project_github_removed
WHERE doc_type IN ('part_studio', 'assembly', 'project_shell')
   OR path ~* '\.(jpart|jasm|jproj)$';
-- Document foreign keys also remove ops, snapshots, previews, comments and proposals.
DELETE FROM documents WHERE id IN (SELECT id FROM junction_cad_docs);
DELETE FROM versions
WHERE id IN (SELECT version_id FROM junction_cad_versions)
  AND NOT EXISTS (SELECT 1 FROM version_docs WHERE version_id = versions.id);
