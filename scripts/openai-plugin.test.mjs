import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ROOT, PACKAGE_FILES, validate, safeFile } from './validate-openai-plugin.mjs';

function fixture(run) {
  const base = resolve(tmpdir());
  const root = mkdtempSync(join(base,'cot-openai-test-'));
  try {
    for (const [,source] of PACKAGE_FILES) {
      const path = join(root,source);
      mkdirSync(dirname(path),{recursive:true});
      copyFileSync(join(ROOT,source),path);
    }
    run(root);
  } finally {
    // Verify the absolute generated cleanup target before recursive removal.
    assert.equal(dirname(resolve(root)),base);
    assert.ok(root.startsWith(join(base,'cot-openai-test-')));
    rmSync(root,{recursive:true,force:true});
  }
}
function editManifest(root, edit) {
  const path = join(root,'.codex-plugin/plugin.json');
  const manifest = JSON.parse(readFileSync(path,'utf8'));
  edit(manifest);
  writeFileSync(path,JSON.stringify(manifest));
}
test('allowlist excludes unrelated files and validated data is a snapshot', () => fixture(root => {
  for (const name of ['.mcpregistry_fixture','dist/ingest.sql','src/unrelated.ts','node_modules/unrelated.js']) {
    const path=join(root,name); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,'not-for-upload');
  }
  const entries=validate(root);
  assert.deepEqual(entries.map(e=>e.name),PACKAGE_FILES.map(([name])=>name));
  const original=entries.find(e=>e.name==='.mcp.json').data;
  writeFileSync(join(root,'.mcp.json'),'{}');
  assert.match(original.toString(),/mcp\.chainofthought\.show/);
}));
test('rejects malformed JSON without exposing its contents', () => fixture(root => {
  writeFileSync(join(root,'.mcp.json'),'{"not-for-upload":');
  assert.throws(()=>validate(root),/^Error: Invalid JSON: \.mcp\.json$/);
}));
test('rejects absent required fields and oversized prompts', () => fixture(root => {
  editManifest(root,m=>{delete m.interface.shortDescription});
  assert.throws(()=>validate(root),/Invalid interface.shortDescription/);
  copyFileSync(join(ROOT,'.codex-plugin/plugin.json'),join(root,'.codex-plugin/plugin.json'));
  editManifest(root,m=>{m.interface.defaultPrompt[0]='a'.repeat(129)});
  assert.throws(()=>validate(root),/Invalid defaultPrompt/);
}));
test('rejects HTTP URLs and credential-bearing server declarations', () => fixture(root => {
  editManifest(root,m=>{m.interface.supportURL='http://example.com'});
  assert.throws(()=>validate(root),/HTTPS URL required/);
  copyFileSync(join(ROOT,'.codex-plugin/plugin.json'),join(root,'.codex-plugin/plugin.json'));
  writeFileSync(join(root,'.mcp.json'),JSON.stringify({mcpServers:{'chain-of-thought':{url:'https://mcp.chainofthought.show/mcp',headers:{Authorization:'not-for-upload'}}}}));
  assert.throws(()=>validate(root),/Unsupported field/);
}));
test('rejects missing or external referenced assets', () => fixture(root => {
  editManifest(root,m=>{m.interface.logo='./assets/missing.svg'});
  assert.throws(()=>validate(root),/Missing or unpackaged/);
  editManifest(root,m=>{m.interface.logo='../outside.svg'});
  assert.throws(()=>validate(root),/Missing or unpackaged/);
  assert.throws(()=>safeFile(root,'../outside.svg'),/Unsafe package path/);
}));
test('rejects symlinked parent directories', () => fixture(root => {
  const link=join(root,'linked');
  symlinkSync(join(root,'assets'),link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>safeFile(root,'linked/mark.svg'),/Symlinks are not allowed/);
}));
test('rejects brand source and wrapper drift', () => fixture(root => {
  writeFileSync(join(root,'assets/mark.svg'),'<svg/>');
  assert.throws(()=>validate(root),/square numeric dimensions/);
  copyFileSync(join(ROOT,'assets/mark.svg'),join(root,'assets/mark.svg'));
  const path=join(root,'assets/brand/cot-mark-white-yellow.svg');
  writeFileSync(path,readFileSync(path,'utf8')+'\n');
  assert.throws(()=>validate(root),/Brand source drift/);
}));
