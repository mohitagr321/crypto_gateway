/**
 * Seed script: create the super_admin user. Idempotent.
 *
 *   npm run seed                       -> email admin@example.com / 'Admin@12345'
 *   npm run seed -- somepassword       -> custom password (positional arg)
 *   SEED_ADMIN_EMAIL=x SEED_ADMIN_PASSWORD=y npm run seed
 *
 * Prints the credentials once. Re-running does not overwrite an existing admin's
 * password (it reports "already exists").
 */
import bcrypt from 'bcryptjs';
import { pool, queryOne } from './db/pool';
import { logger } from './config/logger';

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const password =
    process.argv[2] ?? process.env.SEED_ADMIN_PASSWORD ?? 'Admin@12345';

  const role = await queryOne<{ id: number }>(
    `SELECT id FROM roles WHERE name = 'super_admin'`,
  );
  if (!role) {
    throw new Error('super_admin role missing — run sql/schema.sql first');
  }

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [email],
  );
  if (existing) {
    logger.info({ email }, 'super_admin already exists; skipping');
    // eslint-disable-next-line no-console
    console.log(`\nsuper_admin already exists: ${email}\n`);
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  // email_verified = true — the seeded super_admin is never sent a verification
  // link, and an unverifiable admin account would be unrecoverable.
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO users (email, password_hash, role_id, status, email_verified)
     VALUES ($1, $2, $3, 'active', true)
     RETURNING id`,
    [email, passwordHash, role.id],
  );

  logger.info({ userId: inserted?.id, email }, 'super_admin created');
  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      '==========================================',
      ' super_admin created',
      `   email:    ${email}`,
      `   password: ${password}`,
      '   (change this password after first login)',
      '==========================================',
      '',
    ].join('\n'),
  );

  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, 'seed failed');
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
