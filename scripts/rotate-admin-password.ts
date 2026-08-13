/**
 * One-shot admin password rotation for the LIVE database (no re-seed).
 *
 * Updates the existing AdminUser row's password hash to a NEW value supplied via
 * STORELAH_ADMIN_PASSWORD — the same env var the Lambda and seed read, so a seed
 * run and a rotation always converge on the same credential. Never prints the
 * password. Run from the deployer machine against the DB you intend to update:
 *
 *   DATABASE_URL="$NEON_DIRECT_URL" \
 *     STORELAH_ADMIN_EMAIL=admin@storelah.sg \
 *     STORELAH_ADMIN_PASSWORD=<new-value> \
 *     pnpm db:rotate-admin-password
 *
 * Safe by design: no destructive operations, only an UPDATE of the targeted
 * admin row (email is unique, so updateMany touches at most one row), and it
 * refuses to run when STORELAH_ADMIN_PASSWORD is unset or a known placeholder.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import 'dotenv/config';

const prisma = new PrismaClient();

function die(message: string): never {
  console.error(`rotate-admin-password: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const email = process.env.STORELAH_ADMIN_EMAIL || 'admin@storelah.sg';
  const password = process.env.STORELAH_ADMIN_PASSWORD;

  if (!password || password.length < 8) {
    die('STORELAH_ADMIN_PASSWORD env var is required (min 8 chars). Refusing to run.');
  }
  if (password === 'password' || password === 'change-me') {
    die('refusing to set a known placeholder password.');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await prisma.adminUser.updateMany({
    where: { email },
    data: { passwordHash },
  });

  if (result.count === 0) {
    die(`no AdminUser row found for "${email}" — nothing updated (wrong STORELAH_ADMIN_EMAIL / DB?).`);
  }

  console.log(
    `rotate-admin-password: updated password hash for AdminUser "${email}" (${result.count} row) — no re-seed performed.`,
  );
}

main()
  .catch((err) => {
    console.error('rotate-admin-password:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
