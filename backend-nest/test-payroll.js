const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const runs = await prisma.payrollRun.findMany();
  console.log(JSON.stringify(runs, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
