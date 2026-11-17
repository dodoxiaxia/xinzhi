'use strict';
// Encrypted synthetic PDFs for the site's first-page identity check, written by qpdf (an independent PDF
// implementation, so the decryptor is not checked against itself). Inputs are the invented samples of
// machine_identity_fixtures.cjs: no publisher content. --static-id and --static-aes-iv keep the bytes stable.
// Needs qpdf on PATH (12.x was used): `node scripts/machine_identity_encrypted_fixtures.cjs` rewrites
// scripts/fixtures/machine-identity/encrypted-*.pdf. The test only reads the committed files; CI does not need qpdf.
const fs = require('fs'), os = require('os'), path = require('path'), {spawnSync} = require('child_process');
const base = require('./machine_identity_fixtures.cjs');
const samples = {
  crypt: {doi:'10.9999/synthetic.crypt', title:'Synthetic permission encrypted page tree inside an object stream of an imaginary registry'},
  info: base.samples.custom
};
const owner = '--owner-password=synthetic-owner';
// name → [source, qpdf arguments]. "aesv2-r4-objstm" mirrors the publisher case: AESV2, R4, empty user password,
// modify forbidden (P -1324), catalog and page tree inside an encrypted /ObjStm.
const cases = {
  'encrypted-aesv2-r4-objstm.pdf': ['crypt', ['--object-streams=generate', '--encrypt', '--user-password=', owner, '--bits=128', '--use-aes=y', '--modify=none', '--']],
  'encrypted-rc4-r2-objstm.pdf': ['crypt', ['--allow-weak-crypto', '--object-streams=generate', '--encrypt', '--user-password=', owner, '--bits=40', '--']],
  'encrypted-rc4-r3-objstm.pdf': ['crypt', ['--allow-weak-crypto', '--object-streams=generate', '--encrypt', '--user-password=', owner, '--bits=128', '--use-aes=n', '--']],
  'encrypted-aesv3-r5-objstm.pdf': ['crypt', ['--object-streams=generate', '--encrypt', '--user-password=', owner, '--bits=256', '--force-R5', '--']],
  'encrypted-aesv3-r6-objstm.pdf': ['crypt', ['--object-streams=generate', '--encrypt', '--user-password=', owner, '--bits=256', '--']],
  'encrypted-user-password.pdf': ['crypt', ['--object-streams=generate', '--encrypt', '--user-password=synthetic-user', owner, '--bits=128', '--use-aes=y', '--']],
  'encrypted-aesv2-info-title.pdf': ['info', ['--object-streams=disable', '--encrypt', '--user-password=', owner, '--bits=128', '--use-aes=y', '--']]
};
function sources() {
  return {
    crypt: base.flateEol(samples.crypt),
    info: base.customEncoding({...samples.info, toUnicode:false, infoTitle:samples.info.title})
  };
}
module.exports = {samples, names:Object.keys(cases), directory:base.directory};
if (require.main === module) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-fixtures-')), inputs = sources();
  for (const [key, bytes] of Object.entries(inputs)) fs.writeFileSync(path.join(tmp, key + '.pdf'), bytes);
  for (const [name, [source, args]] of Object.entries(cases)) {
    const out = path.join(base.directory, name);
    // Exit 3 means "succeeded with warnings": the synthetic inputs have no xref table, which qpdf rebuilds.
    const run = spawnSync('qpdf', ['--static-id', '--static-aes-iv', ...args, path.join(tmp, source + '.pdf'), out], {encoding:'utf8'});
    if (run.error || ![0, 3].includes(run.status)) throw new Error(name + ': qpdf failed ' + (run.error || run.stderr));
  }
  fs.rmSync(tmp, {recursive:true, force:true});
  console.log('encrypted machine identity fixtures written');
}
