const fs = require('fs');
const path = require('path');

module.exports = async function () {
    const stagingFile = path.resolve(__dirname, '..', 'results', '.report-staging.json');
    try { if (fs.existsSync(stagingFile)) fs.unlinkSync(stagingFile); } catch {}
};
