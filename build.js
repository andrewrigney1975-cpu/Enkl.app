import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Bumps APP_VERSION in src/js/config.js: increments the minor version by 1
// and stamps the build date/time as YYYYMMDD.HHMM, per the format documented
// next to that constant (major.minor.yyyymmdd.hhmm).
function bumpAppVersion() {
  const configPath = join(__dirname, 'src/js/config.js');
  const configSrc = readFileSync(configPath, 'utf8');

  const versionRegex = /export var APP_VERSION = '(\d+)\.(\d+)\.\d{8}\.\d{4}';/;
  const match = configSrc.match(versionRegex);
  if (!match) {
    throw new Error('Could not find APP_VERSION in src/js/config.js');
  }

  const major = match[1];
  const nextMinor = String(parseInt(match[2], 10) + 1).padStart(2, '0');

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const buildStamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.${pad(now.getHours())}${pad(now.getMinutes())}`;

  const nextVersion = `${major}.${nextMinor}.${buildStamp}`;
  writeFileSync(configPath, configSrc.replace(versionRegex, `export var APP_VERSION = '${nextVersion}';`), 'utf8');
  return nextVersion;
}

async function build() {
  const version = bumpAppVersion();

  // Bundle JS with esbuild (IIFE so all code runs in one scope, no module overhead)
  const result = await esbuild.build({
    entryPoints: [join(__dirname, 'src/js/app.js')],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    sourcemap: false,
  });

  const bundledJs = result.outputFiles[0].text;

  // Read CSS, HTML template, and the keyword-matching web worker's source
  const css = readFileSync(join(__dirname, 'src/css/styles.css'), 'utf8');
  const html = readFileSync(join(__dirname, 'src/index.html'), 'utf8');
  const keywordWorkerSrc = readFileSync(join(__dirname, 'src/js/workers/keyword-worker.js'), 'utf8');

  // Minify CSS with esbuild before inlining
  const cssResult = await esbuild.transform(css, { loader: 'css', minify: true });
  const minifiedCss = cssResult.code.trim();

  // Inline CSS
  let output = html.replace(
    '<link rel="stylesheet" href="css/styles.css">',
    `<style>\n${minifiedCss}\n  </style>`
  );

  // Inline JS. The worker has no fetchable file to load from in this single-file
  // build, so its source is embedded as inert text (an unrecognized script type,
  // never executed by the browser) and turned into a real Worker at runtime via
  // a Blob URL — see src/js/features/document-suggestions.js.
  output = output.replace(
    '<script type="module" src="js/app.js"></script>',
    `<script type="javascript/worker" id="keywordWorkerSource">\n${keywordWorkerSrc}\n  </script>\n  <script>\n${bundledJs}\n  </script>`
  );

  writeFileSync(join(__dirname, 'dist/index.html'), output, 'utf8');
  console.log(`Built dist/index.html (v${version})`);
}

build().catch(err => { console.error(err); process.exit(1); });
