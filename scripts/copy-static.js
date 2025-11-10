const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'src', 'http', 'views');
const destination = path.join(__dirname, '..', 'dist', 'http', 'views');

if (!fs.existsSync(source)) {
  process.exit(0);
}

fs.mkdirSync(destination, { recursive: true });
fs.cpSync(source, destination, { recursive: true });

console.log(`Copied views to ${destination}`);
