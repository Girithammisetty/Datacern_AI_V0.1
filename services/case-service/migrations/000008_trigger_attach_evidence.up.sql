-- Real-time case streams (add-on) slice: intake-snapshot evidence.
-- When a trigger materializes a case, it can freeze the matched source row as
-- a governed CaseEvidence attachment — what the row looked like AT INTAKE,
-- which is what an examiner asks for later. Default false: existing triggers
-- keep their exact behaviour. Forward-only (MASTER-FR-060).
ALTER TABLE case_triggers
    ADD COLUMN attach_evidence BOOLEAN NOT NULL DEFAULT false;
