-- Forward-only migrations (MASTER-FR-060); down provided for local dev resets only.
ALTER TABLE case_triggers DROP COLUMN attach_evidence;
