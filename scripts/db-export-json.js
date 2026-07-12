const { createRizebotDatabase } = require('../src/services/rizebotDatabase');

const database = createRizebotDatabase();
try {
  database.init();
  console.log(JSON.stringify(database.exportRegistrationJsonBackup(), null, 2));
} finally {
  database.close();
}
