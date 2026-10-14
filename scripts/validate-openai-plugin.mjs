/** Validate the documented Codex plugin format and this package's allowlisted surface. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// [ZIP name, checkout source]. No directory traversal or recursive inclusion.
// Use the plugin guide as the ZIP README; the repository README covers server development.
export const PACKAGE_FILES = [
  ['.codex-plugin/plugin.json', '.codex-plugin/plugin.json'],
  ['.mcp.json', '.mcp.json'],
  ['README.md', 'OPENAI_PLUGIN.md'],
  ['LICENSE', 'LICENSE'],
  ['PRIVACY.md', 'PRIVACY.md'],
  ['TERMS.md', 'TERMS.md'],
  ['skills/cite-chain-of-thought/SKILL.md', 'skills/cite-chain-of-thought/SKILL.md'],
  ['assets/mark.svg', 'assets/mark.svg'],
  ['assets/logo.svg', 'assets/logo.svg'],
  ['assets/brand.lock.json', 'assets/brand.lock.json'],
  ['assets/brand/cot-mark-white-yellow.svg', 'assets/brand/cot-mark-white-yellow.svg'],
  ['assets/brand/cot-stacked-plate-dark.svg', 'assets/brand/cot-stacked-plate-dark.svg'],
  ['assets/brand/tokens.json', 'assets/brand/tokens.json'],
].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);

const check = (condition, label) => { if (!condition) throw new Error(label); };
export function safeFile(root, name) {
  check(typeof name === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(name)
    && !name.split('/').some(p => p === '.' || p === '..'), 'Unsafe package path');
  let current = root;
  for (const part of name.split('/')) {
    current = join(current, part);
    check(!lstatSync(current).isSymbolicLink(), 'Symlinks are not allowed: ' + name);
  }
  const rel = relative(realpathSync(root), realpathSync(current));
  check(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')),
    'File escapes package root: ' + name);
  check(lstatSync(current).isFile(), 'Expected regular file: ' + name);
  return current;
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
const text = (value, label, max, multiline = false) => check(
  typeof value === 'string' && value.trim().length > 0 && [...value].length <= max
  && !(multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value), 'Invalid ' + label);
const keys = (value, allowed, label) => {
  check(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object');
  check(Object.keys(value).every(k => allowed.includes(k)), 'Unsupported field in ' + label);
};
function https(value, label, max = 2048) {
  text(value, label, max);
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid URL in ' + label); }
  check(url.protocol === 'https:' && url.hostname && !url.username && !url.password, 'HTTPS URL required in ' + label);
}
function urls(value, label) {
  if (Array.isArray(value)) return value.forEach(v => urls(v, label));
  if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => {
    if (/url$|^homepage$|^repository$/i.test(k)) https(v, label + '.' + k);
    else urls(v, label + '.' + k);
  });
  if (typeof value === 'string') for (const match of value.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"`]+/gi)) {
    https(match[0], label);
  }
}
export function squareBrand(source, background) {
  const normalized = source.replace(/\r\n/g, '\n');
  const opening = normalized.match(/^<svg\b[^>]*>/)?.[0];
  check(opening, 'Brand source must start with svg');
  const box = opening.match(/\bviewBox="0 0 ([\d.]+) ([\d.]+)"/);
  check(box, 'Brand source must have a numeric viewBox');
  const [w, h] = box.slice(1).map(Number);
  const size = Math.max(w, h);
  // Preserve the original paths and colors; center them without stretching.
  const body = normalized.slice(opening.length).replace(/<\/svg>\s*$/, '').trim();
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size
    + '" fill="none" xmlns="http://www.w3.org/2000/svg">\n'
    + '<rect width="' + size + '" height="' + size + '" fill="' + background + '"/>\n'
    + '<g transform="translate(' + ((size - w) / 2) + ' ' + ((size - h) / 2) + ')">\n'
    + body + '\n</g>\n</svg>\n';
}
export function validate(root = ROOT) {
  const entries = PACKAGE_FILES.map(([name, source]) => ({name, data:readFileSync(safeFile(root, source))}));
  const contents = new Map(entries.map(e => [e.name, e.data.toString('utf8')]));
  const json = name => {
    try { return JSON.parse(contents.get(name)); }
    catch { throw new Error('Invalid JSON: ' + name); } // Never echo file contents or values.
  };
  const manifest = json('.codex-plugin/plugin.json');
  keys(manifest, ['name','version','description','author','license','homepage','repository','keywords','skills','mcpServers','interface'], 'manifest');
  check(manifest.name === 'chain-of-thought-podcast', 'Unexpected plugin name');
  check(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Version must be semantic');
  text(manifest.description, 'description', 4000, true);
  keys(manifest.author, ['name','url'], 'author');
  text(manifest.author.name, 'author.name', 120);
  check(manifest.license === 'MIT', 'MIT license required');
  https(manifest.homepage, 'homepage');
  https(manifest.repository, 'repository');
  check(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, 'Keywords required');
  manifest.keywords.forEach(v => text(v, 'keyword', 120));
  check(manifest.skills === './skills/' && manifest.mcpServers === './.mcp.json', 'Invalid component paths');
  const ui = manifest.interface;
  keys(ui, ['displayName','shortDescription','longDescription','developerName','category','capabilities',
    'websiteURL','supportURL','privacyPolicyURL','termsOfServiceURL','defaultPrompt','brandColor','composerIcon','logo'], 'interface');
  for (const [k, max] of [['displayName',30],['shortDescription',30],['longDescription',4000],['developerName',80]])
    text(ui[k], 'interface.' + k, max, k === 'longDescription');
  const categories = ['Productivity','Creativity','Developer Tools','Business & Operations','Data & Analytics',
    'Communication','Education & Research','Security','Finance','Healthcare','Travel','Entertainment','Other'];
  check(categories.includes(ui.category), 'Unsupported category');
  check(Array.isArray(ui.capabilities) && ui.capabilities.length > 0 && ui.capabilities.length <= 20, 'Capabilities required');
  ui.capabilities.forEach(v => text(v, 'capability', 120));
  for (const k of ['websiteURL','supportURL','privacyPolicyURL','termsOfServiceURL']) https(ui[k], k, 1024);
  check(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length === 3, 'Three starter prompts required');
  ui.defaultPrompt.forEach(v => { text(v, 'defaultPrompt', 128); check(!v.includes('@'), 'Starter prompts cannot contain mentions'); });
  check(new Set(ui.defaultPrompt.map(v => v.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim())).size === 3,
    'Starter prompts must be unique');
  check(/^#[0-9a-f]{6}$/i.test(ui.brandColor), 'Invalid brandColor');
  const channels = ui.brandColor.slice(1).match(/../g).map(v => parseInt(v,16)/255)
    .map(v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4);
  check(1.05/(channels[0]*0.2126 + channels[1]*0.7152 + channels[2]*0.0722 + 0.05) >= 2, 'brandColor lacks contrast');
  for (const k of ['composerIcon','logo']) {
    check(typeof ui[k] === 'string' && ui[k].startsWith('./assets/') && contents.has(ui[k].slice(2)),
      'Missing or unpackaged interface asset: ' + k);
    const svg = contents.get(ui[k].slice(2));
    check(Buffer.byteLength(svg) <= 5*1024*1024, 'Icon exceeds 5 MiB');
    const dims = svg.match(/^<svg width="([\d.]+)" height="([\d.]+)" viewBox="0 0 ([\d.]+) ([\d.]+)"/);
    check(dims && dims.slice(1).every(v => Number.isFinite(+v) && +v >= 48)
      && +dims[1] === +dims[2] && +dims[3] === +dims[4], 'Icon must have square numeric dimensions');
  }
  const mcp = json('.mcp.json');
  keys(mcp, ['mcpServers'], 'MCP configuration');
  keys(mcp.mcpServers, ['chain-of-thought'], 'MCP servers');
  keys(mcp.mcpServers['chain-of-thought'], ['url'], 'remote MCP server');
  check(mcp.mcpServers['chain-of-thought'].url === 'https://mcp.chainofthought.show/mcp', 'Unexpected MCP endpoint');
  urls(manifest, 'manifest'); urls(mcp, 'MCP configuration');
  const skill = contents.get('skills/cite-chain-of-thought/SKILL.md');
  check(/^---\r?\nname: cite-chain-of-thought\r?\ndescription: [^\r\n]+\r?\n---\r?\n\s*\S/.test(skill), 'Invalid skill frontmatter or empty body');
  const lock = json('assets/brand.lock.json');
  check(lock.repo === 'cot-brand' && /^[a-f0-9]{40}$/.test(lock.commit) && Array.isArray(lock.assets)
    && lock.assets.length === 3, 'Invalid brand lock');
  for (const asset of lock.assets) {
    check(contents.has(asset.path) && ['approved','secondary'].includes(asset.status), 'Invalid locked brand asset');
    check(sha256(contents.get(asset.path).replace(/\r\n/g,'\n')) === asset.sha256, 'Brand source drift: ' + asset.path);
  }
  const tokens = json('assets/brand/tokens.json');
  check(ui.brandColor === tokens.color.wine.value, 'Brand color drift');
  for (const [output, source] of [['assets/mark.svg','assets/brand/cot-mark-white-yellow.svg'],
    ['assets/logo.svg','assets/brand/cot-stacked-plate-dark.svg']]) {
    check(contents.get(output) === squareBrand(contents.get(source), tokens.color.wineDeep.value), 'Icon wrapper drift: ' + output);
  }
  for (const [name, content] of contents) {
    if (name.endsWith('.json')) urls(json(name), name);
    if (name.endsWith('.md')) urls(content, name);
    // SVG's W3C namespace is an XML identifier, not a fetched service URL.
  }
  return entries;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const entries = validate(); console.log('OK: ' + entries.length + ' plugin files validated'); }
  catch (error) { console.error('Plugin validation failed: ' + error.message); process.exitCode = 1; }
}
