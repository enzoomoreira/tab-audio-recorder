import assert from 'node:assert/strict';

const tag = process.argv[2] ?? process.env['RELEASE_TAG'];
assert.ok(tag && /^v\d+\.\d+\.\d+$/.test(tag), 'Expected a release tag such as v0.1.2');
const pkg = await Bun.file('package.json').json();
const manifest = await Bun.file('src/manifest.json').json();
assert.equal(tag, `v${pkg.version}`, 'Release tag must match package.json');
assert.equal(manifest.version, pkg.version, 'Manifest and package versions must match');
console.log(`Release versions verified: ${tag}`);
