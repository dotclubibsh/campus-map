// Pre-deployment checks for the static site. Run with: node --test tests/site.test.mjs
// These catch the mistakes that break a deploy silently: a CSP hash that no longer
// matches, an offline cache listing a missing file, a broken link or icon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), 'utf8');
const exists = (path) => fs.existsSync(new URL(decodeURIComponent(path), root));
const PAGES = ['index.html', 'legal.html', 'qr.html', '404.html'];

function cspOf(html) {
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  return match && match[1];
}

test('every page has a Content Security Policy that blocks plugins and base hijacking', () => {
  PAGES.forEach((page) => {
    const csp = cspOf(read(page));
    assert.ok(csp, `${page} has no CSP`);
    assert.match(csp, /object-src 'none'/, page);
    assert.match(csp, /base-uri '(self|none)'/, page);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/, `${page} allows inline scripts`);
    assert.doesNotMatch(csp, /'unsafe-eval'/, `${page} allows eval`);
  });
});

test('the only inline script is the import map, and its hash is in the CSP', () => {
  const html = read('index.html');
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(inline.length, 1);
  assert.match(inline[0][1], /type="importmap"/);
  const hash = crypto.createHash('sha256').update(inline[0][2]).digest('base64');
  assert.ok(cspOf(html).includes(`'sha256-${hash}'`), 'import map changed: update its hash in the CSP');
});

test('other pages have no inline scripts at all', () => {
  ['legal.html', 'qr.html', '404.html'].forEach((page) => {
    const inline = [...read(page).matchAll(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/g)];
    assert.equal(inline.length, 0, page);
  });
});

test('third-party scripts and styles are pinned and carry integrity hashes', () => {
  PAGES.forEach((page) => {
    const html = read(page);
    [...html.matchAll(/<(script|link)[^>]+(src|href)="(https:\/\/[^"]+)"[^>]*>/g)].forEach(([tag, , , url]) => {
      if (url.startsWith('https://dotclubibsh.github.io') || /<link[^>]+rel="canonical"/.test(tag)) return;
      assert.match(url, /@\d+\.\d+\.\d+/, `${page}: ${url} is not pinned to a version`);
      assert.match(tag, /integrity="sha384-/, `${page}: ${url} has no integrity hash`);
      assert.match(tag, /crossorigin="anonymous"/, `${page}: ${url} needs crossorigin`);
    });
  });
});

test('links that open a new tab cannot control this page', () => {
  PAGES.forEach((page) => {
    [...read(page).matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].forEach(([tag]) => {
      assert.match(tag, /rel="noopener noreferrer"/, `${page}: ${tag}`);
    });
  });
});

test('every local file a page refers to exists', () => {
  PAGES.filter((p) => p !== '404.html').forEach((page) => {
    const html = read(page);
    [...html.matchAll(/\s(?:src|href)="([^"#:]+?)(?:\?[^"]*)?(?:#[^"]*)?"/g)].forEach(([, path]) => {
      if (path === './' || path === '') return;
      assert.ok(exists(path), `${page} refers to missing ${path}`);
    });
  });
});

test('every file the offline cache needs exists, with matching versions', () => {
  const sw = read('sw.js');
  const files = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
  assert.ok(files.length > 5);
  files.forEach((file) => assert.ok(exists(file.split('?')[0]), `sw.js caches missing ${file}`));

  const appVersion = read('index.html').match(/src="js\/app\.js\?v=(\d+)"/)[1];
  assert.ok(sw.includes(`./js/app.js?v=${appVersion}`), 'sw.js caches a different app.js version');
  const navVersion = read('js/app.js').match(/from '\.\/navigation\.js\?v=(\d+)'/)[1];
  assert.ok(sw.includes(`./js/navigation.js?v=${navVersion}`), 'sw.js caches a different navigation.js version');
});

test('the manifest is installable: name, start URL and correctly sized icons', () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'));
  manifest.icons.forEach((icon) => {
    assert.ok(exists(icon.src), icon.src);
    const png = fs.readFileSync(new URL(icon.src, root));
    const [w, h] = icon.sizes.split('x').map(Number);
    assert.equal(png.readUInt32BE(16), w, `${icon.src} width`);
    assert.equal(png.readUInt32BE(20), h, `${icon.src} height`);
  });
});

test('the sitemap only lists pages that exist', () => {
  const urls = [...read('sitemap.xml').matchAll(/<loc>https:\/\/dotclubibsh\.github\.io\/campus-map\/([^<]*)<\/loc>/g)].map((m) => m[1]);
  assert.ok(urls.length >= 2);
  urls.forEach((url) => assert.ok(exists(url || 'index.html'), url));
});

test('GitHub Pages will publish dot-folders, and security.txt has not expired', () => {
  assert.ok(exists('.nojekyll'), '.nojekyll is needed for .well-known to be published');
  const expires = read('.well-known/security.txt').match(/Expires: (\S+)/)[1];
  assert.ok(new Date(expires) > new Date(), 'security.txt has expired: update the date');
});

test('analytics only load after consent', () => {
  const html = read('index.html');
  assert.doesNotMatch(html, /<script[^>]+googletagmanager/, 'Google Analytics must not be in the page source');
  const app = read('js/app.js');
  assert.match(app, /function loadAnalytics\(\)/);
  const calls = [...app.matchAll(/loadAnalytics\(\)/g)].length;
  assert.equal(calls, 3, 'loadAnalytics should only run from the consent code (definition + 2 calls)');
});

test('every place has a share page and preview picture (run tools/build_share_pages.py if not)', () => {
  const locations = JSON.parse(read('data/locations.json'));
  const places = locations.filter(l => !l.system_data && !l.is_category_node && l.display_name);
  const missing = places.filter(l => !exists(`p/${l.id}/index.html`) || !exists(`assets/share/${l.id}.jpg`)).map(l => l.id);
  assert.deepEqual(missing, [], 'places added since the share pages were last built');
  const stale = fs.readdirSync(new URL('p/', root)).filter(id => !places.some(l => l.id === id));
  assert.deepEqual(stale, [], 'share pages for places that no longer exist');
  assert.ok(exists('assets/share/campus.jpg'));
});

test('share pages open the right place and carry a safe, complete preview', () => {
  const base = read('index.html').match(/<link rel="canonical" href="([^"]+)"/)[1];
  const locations = JSON.parse(read('data/locations.json'));
  fs.readdirSync(new URL('p/', root)).forEach(id => {
    const page = read(`p/${id}/index.html`);
    const csp = cspOf(page);
    assert.ok(csp && /default-src 'none'/.test(csp) && /object-src 'none'/.test(csp), `${id}: CSP`);
    assert.doesNotMatch(page, /<script/i, `${id}: share pages need no scripts`);
    assert.match(page, new RegExp(`<meta http-equiv="refresh" content="0; url=../../\\?place=${id}">`), `${id}: redirect`);
    assert.ok(page.includes(`<meta property="og:image" content="${base}assets/share/${id}.jpg">`), `${id}: og:image`);
    assert.ok(page.includes(`<meta property="og:url" content="${base}p/${id}/">`), `${id}: og:url`);
    // The place name is escaped wherever it appears.
    const name = locations.find(l => l.id === id).display_name.trim();
    const escaped = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
    assert.ok(page.includes(`<meta property="og:title" content="${escaped}">`), `${id}: og:title`);
  });
  const jpeg = fs.readFileSync(new URL('assets/share/fg.jpg', root));
  assert.equal(jpeg.readUInt16BE(0), 0xffd8, 'preview pictures are JPEGs');
});

test('the app shares named places through their preview pages', () => {
  const app = read('js/app.js');
  const appIds = app.match(/const SHAREABLE_ID = \/(.+)\/;/)[1];
  const builderIds = read('tools/build_share_pages.py').match(/SAFE_ID = re\.compile\(r'(.+)'\)/)[1];
  assert.equal(appIds, builderIds, 'js/app.js and tools/build_share_pages.py must agree on which ids get pages');
  assert.match(app, /new URL\(`p\/\$\{loc\.id\}\/`, base\)/);
});

test('the policy page covers what the law and the consent banner promise', () => {
  const legal = read('legal.html');
  ['privacy', 'location', 'consent', 'cookies', 'third-parties', 'rights', 'retention', 'children', 'security', 'terms', 'contact']
    .forEach((id) => assert.match(legal, new RegExp(`id="${id}"`), `missing section #${id}`));
  assert.match(legal, /Digital Personal Data Protection Act, 2023/);
  // Every key the app stores is disclosed.
  const app = read('js/app.js');
  [...app.matchAll(/'(campusMap[A-Za-z]+)'/g)].map((m) => m[1]).forEach((key) => {
    assert.ok(legal.includes(key), `storage key ${key} is not disclosed in legal.html`);
  });
});
