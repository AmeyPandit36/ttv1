-- Phase 2 hardening: published timetable immutability at the database level.
CREATE OR REPLACE FUNCTION chronos_reject_published_mutation()
RETURNS trigger AS $$
DECLARE
  version_status text;
  target_version text;
BEGIN
  IF TG_TABLE_NAME = 'TimetableVersion' THEN
    IF TG_OP = 'UPDATE' AND OLD."status" = 'PUBLISHED' AND (
      NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."version" IS DISTINCT FROM OLD."version"
    ) THEN
      RAISE EXCEPTION 'published timetable is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'TimetableEntry' THEN
    target_version := COALESCE(NEW."versionId", OLD."versionId");
  ELSIF TG_TABLE_NAME = 'TimetableEntrySlot' THEN
    SELECT e."versionId" INTO target_version
    FROM "TimetableEntry" e
    WHERE e."id" = COALESCE(NEW."entryId", OLD."entryId");
  END IF;

  IF target_version IS NOT NULL THEN
    SELECT v."status"::text INTO version_status FROM "TimetableVersion" v WHERE v."id" = target_version;
    IF version_status = 'PUBLISHED' THEN
      RAISE EXCEPTION 'published timetable is immutable';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chronos_timetable_version_immutable ON "TimetableVersion";
CREATE TRIGGER chronos_timetable_version_immutable
BEFORE UPDATE ON "TimetableVersion"
FOR EACH ROW EXECUTE FUNCTION chronos_reject_published_mutation();

DROP TRIGGER IF EXISTS chronos_timetable_entry_immutable ON "TimetableEntry";
CREATE TRIGGER chronos_timetable_entry_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "TimetableEntry"
FOR EACH ROW EXECUTE FUNCTION chronos_reject_published_mutation();

DROP TRIGGER IF EXISTS chronos_timetable_entry_slot_immutable ON "TimetableEntrySlot";
CREATE TRIGGER chronos_timetable_entry_slot_immutable
BEFORE INSERT OR UPDATE OR DELETE ON "TimetableEntrySlot"
FOR EACH ROW EXECUTE FUNCTION chronos_reject_published_mutation();
