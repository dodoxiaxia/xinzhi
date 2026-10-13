'use strict';
const assert = require('assert'),crypto = require('crypto');
const {setup,token} = require('./test_fulltext_auth_helpers.cjs');
const {doi,title,pdf,hash,seed,error} = require('./test_doi_library_worker.cjs');
const {runArchive,driveName} = require('./drive_archive_runner.cjs');
const url = 'https://learn.dryz.info/api/drive-archive', sha = hash(pdf);
async function api(h,body,claims = {},workflow = 'drive-archive.yml') {
  return h.context.worker.fetch(new Request(url,{method:'POST',headers:{authorization:'Bearer ' + await token(h,url,workflow,claims),'content-type':'application/json'},body:JSON.stringify(body)}),h.env);
}
const env = {GITHUB_EVENT_NAME:'schedule',ACTIONS_ID_TOKEN_REQUEST_URL:'https://unit.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-runtime-token',
  GDRIVE_CLIENT_ID:'client',GDRIVE_CLIENT_SECRET:'client-secret',GDRIVE_REFRESH_TOKEN:'refresh-secret',GDRIVE_FOLDER_ID:'folderInbox0123456789'};
function fakeDrive(h, options = {}) {
  const drive = {uploads:[],queries:[],files:options.files || []};
  drive.http = async (target,init = {}) => {
    const u = new URL(target);
    if (u.hostname === 'unit.actions.githubusercontent.com') return Response.json({value:await token(h,url,'drive-archive.yml',{event_name:drive.event || 'schedule'})});
    if (u.hostname === 'learn.dryz.info') return h.context.worker.fetch(new Request(target,init),h.env);
    if (u.hostname === 'oauth2.googleapis.com') { assert(String(init.body).includes('refresh_token=refresh-secret')); return Response.json({access_token:'drive-access'}); }
    assert.equal(init.headers.authorization,'Bearer drive-access');
    if (u.pathname === '/upload/drive/v3/files') {
      const body = Buffer.from(init.body), meta = JSON.parse(body.toString('latin1').split('\r\n\r\n')[1].split('\r\n')[0]);
      assert.deepEqual(meta.parents,['folderInbox0123456789']); assert.equal(meta.appProperties.xinzhiSha256,sha); assert(body.includes(pdf));
      const file = {id:'driveFileUploaded' + drive.uploads.length + '0123',size:String(pdf.length),md5Checksum:crypto.createHash('md5').update(pdf).digest('hex'),sha256Checksum:sha,appSha:sha};
      drive.uploads.push(meta); drive.files.push(file); return Response.json(file);
    }
    if (u.pathname === '/drive/v3/files') { drive.queries.push(u.searchParams.get('q')); return Response.json({files:drive.files.filter(f => u.searchParams.get('q').includes(f.appSha))}); }
    if (u.pathname.startsWith('/drive/v3/files/')) return Response.json({permissions:options.public ? [{type:'user'},{type:'anyone'}] : [{type:'user'}]});
    throw new Error('unexpected request ' + target);
  };
  return drive;
}
(async () => {
  let h = await setup();
  const probe = await h.context.worker.fetch(new Request(url),h.env); assert.equal(probe.status,405); assert.equal((await probe.json()).protocolVersion,1);
  await error(await api(h,{action:'claim'},{},'muse-review.yml'),401,'job_auth');
  seed(h); assert.equal((await (await api(h,{action:'claim'})).json()).task,null,'records stored before this change wait for a backfill');
  await error(await api(h,{action:'backfill'}),401,'job_auth');
  const filled = await (await api(h,{action:'backfill'},{event_name:'workflow_dispatch'})).json(); assert.equal(filled.added,1); assert.equal(filled.cursor,null);
  assert.equal((await (await api(h,{action:'backfill'},{event_name:'workflow_dispatch'})).json()).added,0,'backfill does not queue twice');
  const task = (await (await api(h,{action:'claim'})).json()).task; assert.deepEqual(task,{doi,title,sha256:sha,bytes:pdf.length});
  const bytes = await api(h,{action:'bytes',doi,sha256:sha}); assert.equal(bytes.headers.get('content-type'),'application/pdf'); assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),pdf);
  await error(await api(h,{action:'bytes',doi,sha256:'0'.repeat(64)}),409,'drive_stale');
  await error(await api(h,{action:'complete',doi,sha256:sha,driveFileId:'https://drive.google.com/x'}),400,'drive_bad_request');
  await error(await api(h,{action:'complete',doi,sha256:sha,driveFileId:'driveFile0123456789',extra:1}),400,'drive_bad_request');
  assert.equal((await (await api(h,{action:'complete',doi,sha256:sha,driveFileId:'driveFile0123456789'})).json()).driveFileId,'driveFile0123456789');
  assert.equal((await (await api(h,{action:'complete',doi,sha256:sha,driveFileId:'driveFileOther456789'})).json()).driveFileId,'driveFile0123456789','the first archived copy is kept');
  assert.equal((await (await api(h,{action:'claim'})).json()).task,null); assert(!h.values.has('library:drive-pending:' + sha));
  assert.equal((await (await api(h,{action:'backfill'},{event_name:'workflow_dispatch'})).json()).added,0,'archived originals are not queued again');

  h = await setup(); const acquired = await h.request('/api/acquire'); assert.equal(acquired.status,200);
  assert.equal(JSON.parse(h.values.get('library:drive-pending:' + sha)).doi,doi,'every newly stored original is queued for Drive');
  h.values.set('library:drive-pending:' + '0'.repeat(64),JSON.stringify({doi}));
  assert.equal((await (await api(h,{action:'claim'})).json()).task.sha256,sha); assert(!h.values.has('library:drive-pending:' + '0'.repeat(64)),'a pointer to a superseded original is dropped');

  const logs = []; assert.equal(await runArchive({...env,GDRIVE_REFRESH_TOKEN:''},async () => { throw new Error('unexpected network'); },x => logs.push(x)),0);
  assert(logs[0].startsWith('::warning::')); assert(logs[0].includes('GDRIVE_REFRESH_TOKEN'));
  let drive = fakeDrive(h); const runLogs = [];
  assert.equal(await runArchive(env,drive.http,x => runLogs.push(x),async () => {}),1); assert.equal(drive.uploads.length,1);
  assert.equal(drive.uploads[0].name,driveName({title,doi})); assert(drive.uploads[0].name.endsWith('.pdf')); assert(!drive.uploads[0].name.includes('/'));
  assert.equal(JSON.parse(h.values.get('library:drive:' + sha)).driveFileId,'driveFileUploaded00123');
  assert(!runLogs.join('').match(/refresh-secret|client-secret|drive-access|synthetic-runtime-token|Bearer/));
  assert.equal(await runArchive(env,drive.http,() => {},async () => {}),0); assert.equal(drive.uploads.length,1,'nothing is uploaded twice');

  h = await setup(); await h.request('/api/acquire'); drive = fakeDrive(h,{files:[{id:'driveFileEarlier0123',size:String(pdf.length),md5Checksum:crypto.createHash('md5').update(pdf).digest('hex'),appSha:sha}]});
  assert.equal(await runArchive(env,drive.http,() => {},async () => {}),1); assert.equal(drive.uploads.length,0,'a copy left by a crashed run is reused');
  assert.equal(JSON.parse(h.values.get('library:drive:' + sha)).driveFileId,'driveFileEarlier0123');

  h = await setup(); await h.request('/api/acquire'); drive = fakeDrive(h,{public:true});
  await assert.rejects(runArchive(env,drive.http,() => {},async () => {}),/drive_acl_public/); assert(!h.values.has('library:drive:' + sha)); assert(h.values.has('library:drive-pending:' + sha),'a publicly shared copy is never reported');

  h = await setup(); seed(h); drive = fakeDrive(h);
  await assert.rejects(runArchive({...env,DRIVE_BACKFILL:'true'},drive.http,() => {},async () => {}),/invalid_backfill/);
  drive.event = 'workflow_dispatch';
  assert.equal(await runArchive({...env,DRIVE_BACKFILL:'true',GITHUB_EVENT_NAME:'workflow_dispatch'},drive.http,() => {},async () => {}),1);
  console.log('Drive archive: OIDC-only access, pending index, backfill, dedupe, integrity and private-ACL checks passed');
})().catch(e => { console.error(e); process.exit(1); });
