const { createRizebotDatabase } = require('../src/services/rizebotDatabase');

const database = createRizebotDatabase();
try {
  database.init();
  const result = {};
  try {
    result.registrations = database.exportRegistrationJsonBackup();
  } catch (error) {
    result.registrations = { ok: false, error: error.message };
  }
  result.laws = database.exportLawsJsonBackup();
  result.rules = database.exportRulesCacheJsonBackup();
  console.log(JSON.stringify(result, null, 2));
} finally {
  database.close();
}
