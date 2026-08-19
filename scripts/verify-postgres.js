import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
console.log('Connecting to PostgreSQL using:', connectionString.replace(/:[^:]+@/, ':****@'));

const pool = new pg.Pool({ connectionString });

async function run() {
  const client = await pool.connect();
  try {
    console.log('Testing connection...');
    await client.query('SELECT now()');
    console.log('Connection successful.');

    // Create a temporary schema for isolated repeatable testing
    const testSchema = `p3_verify_${crypto.randomBytes(4).toString('hex')}`;
    console.log(`Creating test schema: ${testSchema}`);
    await client.query(`CREATE SCHEMA ${testSchema}`);
    await client.query(`SET search_path TO ${testSchema}, public`);

    // Read and apply migration 1 (Initial Schema)
    console.log('Reading migration 1 (Initial)...');
    const mig1Path = fileURLToPath(new URL('../prisma/migrations/20260819000000_initial/migration.sql', import.meta.url));
    const mig1Sql = await readFile(mig1Path, 'utf8');
    console.log('Applying migration 1...');
    // Replace pgcrypto and text default overrides to run safely inside the test schema
    await client.query(mig1Sql.replaceAll('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
    console.log('Migration 1 applied.');

    // Read and apply migration 2 (Phase 2 Hardening Triggers)
    console.log('Reading migration 2 (Hardening Triggers)...');
    const mig2Path = fileURLToPath(new URL('../prisma/migrations/20260819100000_phase2_hardening/migration.sql', import.meta.url));
    const mig2Sql = await readFile(mig2Path, 'utf8');
    console.log('Applying migration 2...');
    await client.query(mig2Sql);
    console.log('Migration 2 applied.');

    // Verify table existence
    console.log('Asserting table presence...');
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = $1
    `, [testSchema]);
    const tableNames = tablesResult.rows.map(r => r.table_name);
    const requiredTables = ['User', 'AcademicYear', 'Department', 'Resource', 'Faculty', 'Timetable', 'TimetableVersion', 'TimetableEntry', 'TimetableEntrySlot'];
    for (const t of requiredTables) {
      if (!tableNames.includes(t)) {
        throw new Error(`Required table "${t}" is missing from schema.`);
      }
    }
    console.log('✓ All tables are present.');

    // Seed test records
    console.log('Seeding minimal records for trigger testing...');
    const ayId = crypto.randomUUID();
    await client.query(`INSERT INTO "AcademicYear"("id","name","startsOn","endsOn") VALUES ($1,'2026–27',now(),now() + interval '1 year')`, [ayId]);
    const depId = crypto.randomUUID();
    await client.query(`INSERT INTO "Department"("id","code","name") VALUES ($1,'IT','Information Technology')`, [depId]);
    const profileId = crypto.randomUUID();
    await client.query(`INSERT INTO "ScheduleProfile"("id","name","academicYearId") VALUES ($1,'Standard Profile',$2)`, [profileId, ayId]);
    const timetableId = crypto.randomUUID();
    await client.query(`INSERT INTO "Timetable"("id","name","academicYearId","profileId") VALUES ($1,'Test Timetable',$2,$3)`, [timetableId, ayId, profileId]);
    
    // Create a DRAFT TimetableVersion
    const versionId = crypto.randomUUID();
    await client.query(`INSERT INTO "TimetableVersion"("id","timetableId","version","status") VALUES ($1,$2,1,'DRAFT')`, [versionId, timetableId]);

    const facId = crypto.randomUUID();
    await client.query(`INSERT INTO "Faculty"("id","employeeCode","name","email","departmentId") VALUES ($1,'EMP01','Test Faculty','test@chronos.local',$2)`, [facId, depId]);
    const subId = crypto.randomUUID();
    await client.query(`INSERT INTO "Subject"("id","code","name","departmentId") VALUES ($1,'CS101','Computer Science',$2)`, [subId, depId]);
    const reqId = crypto.randomUUID();
    await client.query(`INSERT INTO "TeachingRequirement"("id","subjectId","facultyId","sessionType","durationPeriods","weeklyFrequency","resourceType") VALUES ($1,$2,$3,'LECTURE',1,1,'CLASSROOM')`, [reqId, subId, facId]);
    const sessionId = crypto.randomUUID();
    await client.query(`INSERT INTO "SchedulableSession"("id","requirementId","occurrence","durationPeriods","fingerprint") VALUES ($1,$2,1,1,'FINGERPRINT_1')`, [sessionId, reqId]);
    const resId = crypto.randomUUID();
    await client.query(`INSERT INTO "Resource"("id","code","name","type","capacity","departmentId") VALUES ($1,'RES01','Room 101','CLASSROOM',50,$2)`, [resId, depId]);

    // Verify draft is mutable
    console.log('Asserting DRAFT timetable version is mutable...');
    const entryId = crypto.randomUUID();
    await client.query(`INSERT INTO "TimetableEntry"("id","versionId","sessionId","resourceId") VALUES ($1,$2,$3,$4)`, [entryId, versionId, sessionId, resId]);
    console.log('✓ Successfully inserted entry in draft.');

    // Transition version to PUBLISHED
    console.log('Transitioning version status to PUBLISHED...');
    await client.query(`UPDATE "TimetableVersion" SET "status"='PUBLISHED' WHERE "id"=$1`, [versionId]);

    // Verify published is immutable
    console.log('Asserting PUBLISHED timetable entries reject modifications...');
    try {
      const entryId2 = crypto.randomUUID();
      const sessionId2 = crypto.randomUUID();
      await client.query(`INSERT INTO "SchedulableSession"("id","requirementId","occurrence","durationPeriods","fingerprint") VALUES ($1,$2,2,1,'FINGERPRINT_2')`, [sessionId2, reqId]);
      await client.query(`INSERT INTO "TimetableEntry"("id","versionId","sessionId","resourceId") VALUES ($1,$2,$3,$4)`, [entryId2, versionId, sessionId2, resId]);
      throw new Error('Trigger FAILED: Managed to insert timetable entry into a PUBLISHED version!');
    } catch (e) {
      if (e.message.includes('published timetable is immutable')) {
        console.log('✓ Trigger successfully intercepted insert on PUBLISHED timetable.');
      } else {
        throw e;
      }
    }

    try {
      await client.query(`UPDATE "TimetableEntry" SET "resourceId"=$1 WHERE "id"=$2`, [resId, entryId]);
      throw new Error('Trigger FAILED: Managed to update timetable entry in a PUBLISHED version!');
    } catch (e) {
      if (e.message.includes('published timetable is immutable')) {
        console.log('✓ Trigger successfully intercepted update on PUBLISHED timetable.');
      } else {
        throw e;
      }
    }

    try {
      await client.query(`DELETE FROM "TimetableEntry" WHERE "id"=$1`, [entryId]);
      throw new Error('Trigger FAILED: Managed to delete timetable entry in a PUBLISHED version!');
    } catch (e) {
      if (e.message.includes('published timetable is immutable')) {
        console.log('✓ Trigger successfully intercepted delete on PUBLISHED timetable.');
      } else {
        throw e;
      }
    }

    // Verify transaction rollback behaves correctly on errors
    console.log('Verifying transaction rollback capability...');
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO "Department"("id","code","name") VALUES ($1,'IT_ROLLBACK','Information Technology Rollback')`, [crypto.randomUUID()]);
      // Introduce an intentional unique constraint error
      await client.query(`INSERT INTO "Department"("id","code","name") VALUES ($1,'IT_ROLLBACK','Information Technology Rollback')`, [crypto.randomUUID()]);
      await client.query('COMMIT');
      throw new Error('Rollback failed to reject duplicate values.');
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('✓ Transaction correctly rolled back.');
      // Verify row does not exist
      const checkRes = await client.query(`SELECT 1 FROM "Department" WHERE "code"='IT_ROLLBACK'`);
      if (checkRes.rows.length > 0) {
        throw new Error('Rollback test FAILED: rollback did not remove dirty rows!');
      }
      console.log('✓ Confirmed database state is clean after rollback.');
    }

    // Verify Concurrency-safe version allocation using parallel connections
    console.log('Verifying concurrency-safe version allocation using separate parallel connections...');
    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      await client1.query(`SET search_path TO ${testSchema}, public`);
      await client2.query(`SET search_path TO ${testSchema}, public`);

      await client1.query('BEGIN');
      await client2.query('BEGIN');

      console.log('Client 1 acquiring FOR UPDATE lock and version...');
      await client1.query(`SELECT "id" FROM "Timetable" WHERE "id"=$1 FOR UPDATE`, [timetableId]);
      const res1 = await client1.query(`SELECT COALESCE(max("version"),0)+1 n FROM "TimetableVersion" WHERE "timetableId"=$1`, [timetableId]);
      const vNum1 = Number(res1.rows[0].n);
      const v1Id = crypto.randomUUID();
      await client1.query(`INSERT INTO "TimetableVersion"("id","timetableId","version","status") VALUES ($1,$2,$3,'DRAFT')`, [v1Id, timetableId, vNum1]);

      console.log('Client 2 attempting to acquire lock (should block)...');
      let client2Finished = false;
      const client2Promise = (async () => {
        await client2.query(`SELECT "id" FROM "Timetable" WHERE "id"=$1 FOR UPDATE`, [timetableId]);
        const res2 = await client2.query(`SELECT COALESCE(max("version"),0)+1 n FROM "TimetableVersion" WHERE "timetableId"=$1`, [timetableId]);
        const vNum2 = Number(res2.rows[0].n);
        const v2Id = crypto.randomUUID();
        await client2.query(`INSERT INTO "TimetableVersion"("id","timetableId","version","status") VALUES ($1,$2,$3,'DRAFT')`, [v2Id, timetableId, vNum2]);
        client2Finished = true;
        return vNum2;
      })();

      // Wait a short time to check if Client 2 is blocked (client2Promise shouldn't be resolved yet)
      await new Promise(r => setTimeout(r, 200));
      if (client2Finished) {
        throw new Error('Concurrency locking FAILED: Client 2 did not block while Client 1 held the Timetable lock.');
      }
      console.log('✓ Confirmed Client 2 blocked correctly.');

      console.log('Committing Client 1 transaction...');
      await client1.query('COMMIT');

      console.log('Waiting for Client 2 to acquire lock and finish version allocation...');
      const vNum2 = await client2Promise;
      await client2.query('COMMIT');

      console.log(`Client 1 allocated version: ${vNum1}, Client 2 allocated version: ${vNum2}`);
      expect(vNum1).not.toBe(vNum2);
      expect(vNum2).toBe(vNum1 + 1);
      console.log('✓ Successfully serialized and allocated distinct concurrent version numbers.');

    } finally {
      client1.release();
      client2.release();
    }

    // Clean up temporary schema
    console.log(`Cleaning up test schema: ${testSchema}`);
    await client.query(`DROP SCHEMA ${testSchema} CASCADE`);
    console.log('PostgreSQL integrity and verification workflow completed successfully!');

  } finally {
    client.release();
  }
}

// Simple assertion helper
function expect(val) {
  return {
    toBe(expected) {
      if (val !== expected) throw new Error(`Expected ${val} to be ${expected}`);
    },
    not: {
      toBe(expected) {
        if (val === expected) throw new Error(`Expected ${val} NOT to be ${expected}`);
      }
    }
  };
}

run().catch(error => {
  console.error('PostgreSQL verification failed:', error);
  process.exit(1);
});
