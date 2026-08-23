// Vercel has no runtime env for a static page, so the API base is baked at
// build time into a one-line script the page loads before its own.
import { writeFileSync } from 'node:fs';
const api = process.env.API_BASE_URL || 'http://localhost:8080';
writeFileSync(new URL('./env.js', import.meta.url),
  `window.ATRIUM_API=${JSON.stringify(api)};\n`);
console.log('env.js -> ' + api);
