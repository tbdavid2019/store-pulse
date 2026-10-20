import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');

// Create public directory
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

// Copy top-level static files
const staticFiles = ['index.html', 'manifest.json', 'service-worker.js', 'llms.txt', 'robots.txt', 'sitemap.xml', 'CHANGELOG.md'];
for (const file of staticFiles) {
  const src = path.join(root, file);
  const dest = path.join(publicDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
    console.log(`Copied ${file} -> public/${file}`);
  }
}

// Copy icons directory
const iconsSrc = path.join(root, 'icons');
const iconsDest = path.join(publicDir, 'icons');
if (fs.existsSync(iconsSrc)) {
  fs.cpSync(iconsSrc, iconsDest, { recursive: true });
  console.log('Copied icons/ -> public/icons/');
}

console.log('Public assets build completed successfully.');
