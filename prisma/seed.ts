/**
 * Explicit demo-institution seed. Production bootstrap never calls this.
 *
 *   CHRONOS_SEED_DEMO=1 npm run db:seed
 *   CHRONOS_SEED_DEMO=1 npm run dev
 */
process.env.CHRONOS_SEED_DEMO = '1';
const {ready} = await import('../apps/api/src/db.ts');
await ready;
console.log('Explicit Campus Chronos demo seed completed.');
