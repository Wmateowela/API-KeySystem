const fs = require('fs');
const path = require('path');

const saPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(saPath)) {
    console.error('serviceAccountKey.json not found');
    process.exit(1);
}

const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));
// Minify and escape for single-line env var
const minified = JSON.stringify(sa);
console.log('---');
console.log('Copy this ENTIRE line into Render Environment Variable:');
console.log('Name: FIREBASE_SERVICE_ACCOUNT');
console.log('Value (one line):');
console.log(minified);
console.log('---');
console.log('Length:', minified.length, 'chars');
