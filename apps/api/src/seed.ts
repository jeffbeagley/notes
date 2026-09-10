import argon2 from 'argon2';
import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  if (await prisma.user.count()) return;

  const username = process.env.DEFAULT_ADMIN_USERNAME ?? 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('DEFAULT_ADMIN_PASSWORD must be set to at least 12 characters to seed the first admin account.');
  }

  await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(password),
      role: UserRole.admin,
      forcePasswordChange: true,
    },
  });
  console.log(`Seeded initial admin user "${username}". You must change this password on first sign-in.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());