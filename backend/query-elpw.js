const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Check audit logs for ELPW
  console.log('=== ELPW AUDIT LOGS (last 24h) ===\n');

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const auditLogs = await prisma.auditLog.findMany({
    where: {
      ticker: 'ELPW',
      timestamp: { gte: oneDayAgo }
    },
    orderBy: { timestamp: 'desc' }
  });

  for (const log of auditLogs) {
    console.log(`[${log.timestamp.toLocaleString()}] ${log.event_type}`);
    if (log.details) {
      try {
        const details = JSON.parse(log.details);
        console.log('   Details:', JSON.stringify(details, null, 2).replace(/\n/g, '\n   '));
      } catch {
        console.log('   Details:', log.details);
      }
    }
    console.log('');
  }

  // Check positions for ELPW
  console.log('\n=== ELPW POSITIONS ===\n');

  const positions = await prisma.position.findMany({
    where: { ticker: 'ELPW' }
  });

  if (positions.length === 0) {
    console.log('No positions found for ELPW');
  } else {
    for (const pos of positions) {
      console.log(`Ticker: ${pos.ticker}`);
      console.log(`Status: ${pos.status}`);
      console.log(`Quantity: ${pos.quantity}`);
      console.log(`Entry Price: ${pos.entry_price}`);
      console.log(`Created: ${pos.created_at}`);
      console.log('');
    }
  }

  // Check all executions for ELPW
  console.log('\n=== ELPW EXECUTIONS ===\n');

  const executions = await prisma.execution.findMany({
    where: { ticker: 'ELPW' },
    orderBy: { created_at: 'desc' }
  });

  for (const exec of executions) {
    console.log(`[${exec.created_at.toLocaleString()}] ${exec.order_action} - Status: ${exec.status}`);
    console.log(`   Qty: ${exec.quantity} @ $${exec.limit_price}`);
    if (exec.error_message) console.log(`   Error: ${exec.error_message}`);
    console.log('');
  }

  // Check for any EXIT events in raw webhook logs
  console.log('\n=== Looking for EXIT signals in audit logs ===\n');

  const exitLogs = await prisma.auditLog.findMany({
    where: {
      OR: [
        { event_type: { contains: 'exit' } },
        { event_type: { contains: 'EXIT' } },
        { details: { contains: 'ELPW' } }
      ],
      timestamp: { gte: oneDayAgo }
    },
    orderBy: { timestamp: 'desc' },
    take: 20
  });

  for (const log of exitLogs) {
    if (log.details && log.details.includes('ELPW')) {
      console.log(`[${log.timestamp.toLocaleString()}] ${log.event_type}`);
      console.log(`   Ticker: ${log.ticker || 'N/A'}`);
      console.log('');
    }
  }

  await prisma.$disconnect();
}

main().catch(console.error);
