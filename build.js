import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function build() {
  // Bundle JS with esbuild (IIFE so all code runs in one scope, no module overhead)
  const result = await esbuild.build({
    entryPoints: [join(__dirname, 'src/js/app.js')],
    bundle: true,
    format: 'iife',
    minify: false,
    write: false,
    sourcemap: false,
  });

  const bundledJs = result.outputFiles[0].text;

  // Read CSS, HTML template, and the keyword-matching web worker's source
  const css = readFileSync(join(__dirname, 'src/css/styles.css'), 'utf8');
  const html = readFileSync(join(__dirname, 'src/index.html'), 'utf8');
  const keywordWorkerSrc = readFileSync(join(__dirname, 'src/js/workers/keyword-worker.js'), 'utf8');

  // Inline CSS
  let output = html.replace(
    '<link rel="stylesheet" href="css/styles.css">',
    `<style>\n${css}\n  </style>`
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
  console.log('Built dist/index.html');
}

build().catch(err => { console.error(err); process.exit(1); });
