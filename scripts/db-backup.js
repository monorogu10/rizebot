const { createRizebotDatabase } = require('../src/services/rizebotDatabase');

async function main() {
  const database = createRizebotDatabase();
  try {
    database.init();
    const result = await database.createBackup({ reason: 'cli' });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    database.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
