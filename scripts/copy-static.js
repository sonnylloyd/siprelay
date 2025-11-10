const fs = require('fs');
const path = require('path');

const items = [
  { source: path.join(__dirname, '..', 'src', 'http', 'views'), destination: path.join(__dirname, '..', 'dist', 'http', 'views') },
  { source: path.join(__dirname, '..', 'images'), destination: path.join(__dirname, '..', 'dist', 'images') },
];

for (const item of items) {
  if (!fs.existsSync(item.source)) continue;
  fs.mkdirSync(item.destination, { recursive: true });
  fs.cpSync(item.source, item.destination, { recursive: true });
  console.log(`Copied ${item.source} -> ${item.destination}`);
}
