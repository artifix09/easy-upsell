import crypto from 'node:crypto';
import fs from 'node:fs';

const [secret, filePath] = process.argv.slice(2);
if (!secret || !filePath) {
  console.error('Usage: node hmac-generate.mjs <secret> <json-file>');
  process.exit(1);
}

const body = fs.readFileSync(filePath);
const signature = crypto.createHmac('sha256', secret).update(body).digest('base64');

console.log(signature);
