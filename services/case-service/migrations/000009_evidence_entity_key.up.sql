-- Knowledge Spine WS5: evidence can name the governed ontology entity type it
-- instantiates (a loss-run PDF is about a "policy"; an intake form about a
-- "claim"). Optional — untagged evidence stays exactly as before. The key's
-- registry lives in dataset-service; case-service stores the shape-checked
-- string, and the UI offers only keys the workspace registry declares.
ALTER TABLE case_evidence ADD COLUMN entity_key TEXT;
