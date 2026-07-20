const fs = require('fs');
const html = fs.readFileSync('../dist/index.html', 'utf8');
function log(label, ok, extra){ console.log((ok?'PASS':'FAIL') + ' - ' + label + (extra?' :: '+extra:'')); }

function pngDimensions(buf){
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

(async () => {
  const manifestMatch = html.match(/<link rel="manifest" href="data:application\/manifest\+json;base64,([A-Za-z0-9+/=]+)">/);
  log('a <link rel="manifest"> tag exists, embedded as a base64 data URI', !!manifestMatch);

  let manifest = null;
  if (manifestMatch) {
    const manifestJson = Buffer.from(manifestMatch[1], 'base64').toString('utf-8');
    try { manifest = JSON.parse(manifestJson); } catch (e) {}
  }
  log('manifest decodes to valid JSON', !!manifest);
  log('manifest has a name and short_name', manifest && manifest.name === 'Enklr' && manifest.short_name === 'Enklr', manifest && manifest.name);
  log('manifest display mode is "standalone" (proper PWA install behavior)', manifest && manifest.display === 'standalone');
  log('manifest start_url is set', manifest && !!manifest.start_url);

  const headerColorMatch = html.match(/--kf-navy:\s*(#[0-9a-fA-F]{6})/);
  const headerColor = headerColorMatch ? headerColorMatch[1] : null;
  log('found the header\u2019s --kf-navy color variable', !!headerColor, headerColor);
  log('manifest theme_color matches the header color exactly', manifest && headerColor && manifest.theme_color.toLowerCase() === headerColor.toLowerCase(),
      manifest && manifest.theme_color + ' vs ' + headerColor);

  const themeColorMetaMatch = html.match(/<meta name="theme-color" content="(#[0-9a-fA-F]{6})">/);
  log('a <meta name="theme-color"> tag exists', !!themeColorMetaMatch);
  log('theme-color meta tag matches the header color exactly', themeColorMetaMatch && headerColor &&
      themeColorMetaMatch[1].toLowerCase() === headerColor.toLowerCase(), themeColorMetaMatch && themeColorMetaMatch[1]);

  log('manifest declares exactly 2 icons', manifest && manifest.icons.length === 2, manifest && manifest.icons.length);
  if (manifest) {
    manifest.icons.forEach(icon => {
      const b64 = icon.src.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      const isPng = buf.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
      log('icon declared as ' + icon.sizes + ' is a real, valid PNG', isPng);
      if (isPng) {
        const dims = pngDimensions(buf);
        const [declaredW, declaredH] = icon.sizes.split('x').map(Number);
        log('icon ' + icon.sizes + ' actual pixel dimensions match what\u2019s declared',
            dims.width === declaredW && dims.height === declaredH, `${dims.width}x${dims.height}`);
      }
      log('icon ' + icon.sizes + ' has purpose set for maskable support', icon.purpose && icon.purpose.indexOf('maskable') !== -1);
    });
  }

  log('apple-mobile-web-app-capable is set to yes', /<meta name="apple-mobile-web-app-capable" content="yes">/.test(html));
  log('apple-mobile-web-app-status-bar-style is set', /<meta name="apple-mobile-web-app-status-bar-style" content="[^"]+">/.test(html));
  log('apple-mobile-web-app-title is set to Enklr', /<meta name="apple-mobile-web-app-title" content="Enklr">/.test(html));

  const appleIconMatches = [...html.matchAll(/<link rel="apple-touch-icon"[^>]*href="data:image\/png;base64,([A-Za-z0-9+/=]+)">/g)];
  log('at least one apple-touch-icon link exists', appleIconMatches.length >= 1, appleIconMatches.length);
  appleIconMatches.forEach((m, i) => {
    const buf = Buffer.from(m[1], 'base64');
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
    log('apple-touch-icon #' + (i+1) + ' is a real, valid PNG', isPng);
  });
  log('a 192x192 apple-touch-icon variant is declared', /<link rel="apple-touch-icon" sizes="192x192"/.test(html));
  log('a 512x512 apple-touch-icon variant is declared', /<link rel="apple-touch-icon" sizes="512x512"/.test(html));

  log('mobile-web-app-capable is set to yes (Android)', /<meta name="mobile-web-app-capable" content="yes">/.test(html));

  const headSection = html.slice(0, html.indexOf('<style>'));
  const hasExternalManifestOrIcon = /<link rel="(manifest|apple-touch-icon|icon)"[^>]*href="(?!data:)[^"]*"/.test(headSection);
  log('manifest and icons are embedded as data URIs, not external file references (keeps this a single-file app)', !hasExternalManifestOrIcon);

  log('the SVG favicon link is present with the current square, full-bleed background design', html.indexOf("rect x='0' y='0' width='24' height='24' fill='%230c66e4'") !== -1);

  console.log('\nPWA support test complete.');
  process.exit(0);
})().catch(e => { console.error('CRASHED', e); process.exit(1); });
