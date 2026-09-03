
-- ═══════════════════════════════════════════════════════════════════════════
-- Platform invariants enforced in the database, not by convention.
-- See docs/00-overview.md §4 and docs/02-data-model.md §10.
-- ═══════════════════════════════════════════════════════════════════════════

-- I3 — Approved artifact versions are immutable.
-- The only permitted change to an APPROVED version is retiring it to SUPERSEDED.
-- Content, hash and version number can never change once approved.
CREATE OR REPLACE FUNCTION artifact_versions_enforce_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    IF NEW."contentJson"   IS DISTINCT FROM OLD."contentJson"
    OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
    OR NEW.version         IS DISTINCT FROM OLD.version
    OR NEW."artifactId"    IS DISTINCT FROM OLD."artifactId" THEN
      RAISE EXCEPTION
        'artifact_versions: approved version %/% is immutable (invariant I3)',
        OLD."artifactId", OLD.version
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW.status <> OLD.status AND NEW.status <> 'SUPERSEDED' THEN
      RAISE EXCEPTION
        'artifact_versions: approved version %/% may only move to SUPERSEDED, not % (invariant I3)',
        OLD."artifactId", OLD.version, NEW.status
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_versions_no_update_when_approved ON artifact_versions;
CREATE TRIGGER artifact_versions_no_update_when_approved
  BEFORE UPDATE ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION artifact_versions_enforce_immutability();

-- Content of an artifact version is insert-only even before approval: a revision is a new row.
CREATE OR REPLACE FUNCTION artifact_versions_block_content_rewrite()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."contentJson" IS DISTINCT FROM OLD."contentJson"
     AND OLD."producedByRunId" IS NOT NULL THEN
    RAISE EXCEPTION
      'artifact_versions: content is insert-only; create version % instead',
      OLD.version + 1
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS artifact_versions_content_insert_only ON artifact_versions;
CREATE TRIGGER artifact_versions_content_insert_only
  BEFORE UPDATE ON artifact_versions
  FOR EACH ROW EXECUTE FUNCTION artifact_versions_block_content_rewrite();

-- ADRs are immutable once approved; supersession is the only forward path.
CREATE OR REPLACE FUNCTION adrs_enforce_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'APPROVED'
     AND (NEW.decision  IS DISTINCT FROM OLD.decision
       OR NEW.context   IS DISTINCT FROM OLD.context
       OR NEW.problem   IS DISTINCT FROM OLD.problem
       OR NEW.rationale IS DISTINCT FROM OLD.rationale) THEN
    RAISE EXCEPTION
      'adrs: ADR-% is immutable once approved; supersede it instead', OLD.number
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS adrs_no_update_when_approved ON adrs;
CREATE TRIGGER adrs_no_update_when_approved
  BEFORE UPDATE ON adrs
  FOR EACH ROW EXECUTE FUNCTION adrs_enforce_immutability();

-- The architecture critic must not be the architect that authored the option.
-- Independent evaluation is a structural guarantee, not a prompt instruction (docs/02 §6).
CREATE OR REPLACE FUNCTION architecture_evaluations_require_independent_critic()
RETURNS TRIGGER AS $$
DECLARE
  evaluator_key TEXT;
  author_run_id TEXT;
BEGIN
  IF NEW."agentRunId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "agentKey" INTO evaluator_key FROM agent_runs WHERE id = NEW."agentRunId";
  IF evaluator_key IS NOT NULL AND evaluator_key <> 'architecture-critic' THEN
    RAISE EXCEPTION
      'architecture_evaluations: evaluations must be produced by architecture-critic, not %',
      evaluator_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT "agentRunId" INTO author_run_id FROM architecture_options WHERE id = NEW."optionId";
  IF author_run_id IS NOT NULL AND author_run_id = NEW."agentRunId" THEN
    RAISE EXCEPTION
      'architecture_evaluations: an option cannot be scored by the run that authored it'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS architecture_evaluations_independent_critic ON architecture_evaluations;
CREATE TRIGGER architecture_evaluations_independent_critic
  BEFORE INSERT OR UPDATE ON architecture_evaluations
  FOR EACH ROW EXECUTE FUNCTION architecture_evaluations_require_independent_critic();

-- Estimates must always carry a confidence and a planning range (docs/02 §7).
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_confidence_range;
ALTER TABLE estimates ADD CONSTRAINT estimates_confidence_range
  CHECK (confidence >= 0 AND confidence <= 1);

ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_planning_range;
ALTER TABLE estimates ADD CONSTRAINT estimates_planning_range
  CHECK ("rangeLowHours" >= 0 AND "rangeHighHours" >= "rangeLowHours");

-- Domain events are append-only: no row may ever be edited.
--
-- Deleting one is refused too, with one deliberate exception: when a project is deleted, its
-- events cascade. By the time this trigger fires during that cascade the parent row is already
-- gone, which is how we tell an admin deleting a project from someone quietly erasing an audit
-- trail. Tampering is what the invariant guards against, not lifecycle.
CREATE OR REPLACE FUNCTION domain_events_no_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'domain_events is append-only; events cannot be edited'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION domain_events_delete_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE id = OLD."projectId") THEN
    RAISE EXCEPTION 'domain_events cannot be deleted while its project exists'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS domain_events_no_mutation ON domain_events;
DROP TRIGGER IF EXISTS domain_events_no_update ON domain_events;
CREATE TRIGGER domain_events_no_update
  BEFORE UPDATE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION domain_events_no_update();

DROP TRIGGER IF EXISTS domain_events_delete_guard ON domain_events;
CREATE TRIGGER domain_events_delete_guard
  BEFORE DELETE ON domain_events
  FOR EACH ROW EXECUTE FUNCTION domain_events_delete_guard();

-- Retrieval index for the Context Engine (docs/09 §7).
CREATE INDEX IF NOT EXISTS document_chunks_embedding_hnsw
  ON document_chunks USING hnsw (embedding vector_cosine_ops);

-- The approvals inbox is the hottest read in the dashboard.
CREATE INDEX IF NOT EXISTS approval_requests_pending
  ON approval_requests ("projectId") WHERE status = 'PENDING';

-- Trigram search over story text for the BA duplicate detector.
CREATE INDEX IF NOT EXISTS stories_title_trgm ON stories USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS requirements_statement_trgm
  ON requirements USING gin (statement gin_trgm_ops);
