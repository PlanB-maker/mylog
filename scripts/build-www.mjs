// Copies the web app into www/ for the Android build and stamps the app version.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('www', { recursive: true, force: true });
mkdirSync('www', { recursive: true });
let html = readFileSync('index.html', 'utf8');
if (!html.includes("const APP_VERSION = '0.0.0';")) throw new Error('APP_VERSION marker missing in index.html');
html = html.replace("const APP_VERSION = '0.0.0';", `const APP_VERSION = '${pkg.version}';`);
writeFileSync('www/index.html', html);
cpSync('icons', 'www/icons', { recursive: true });
cpSync('manifest.webmanifest', 'www/manifest.webmanifest');
console.log('www built, version', pkg.version);
