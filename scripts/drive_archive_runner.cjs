'use strict';
// Copies every verified original in the site library to the private Drive inbox, then records the Drive file ID.
// The site never holds Drive credentials; this workflow never holds the site's full-text passphrase or Muse key.
const {identityToken} = require('./fulltext_queue_runner.cjs');
const {readJson,ready,serviceError,failureLog} = require('./fulltext_import_runner.cjs');
const crypto = require('crypto');
const ENDPOINT = 'https://learn.dryz.info/api/drive-archive';
const DRIVE = 'https://www.googleapis.com/drive/v3/files', UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true';
const MAX_BYTES = 10 * 1024 * 1024, PER_RUN = 20;
const validDoi = doi => typeof doi === 'string' && /^10\.\d{4,9}\/[\x21-\x7e]{1,200}$/.test(doi) && doi === doi.toLowerCase() && !/[<>?#@\\]/.test(doi);
function driveName(task) {
  const title = Array.from(task.title.replace(/[\x00-\x1f\x7f\/\\":<>|?*]/g,' ').replace(/\s+/g,' ').trim()).slice(0,120).join('');
  return (title ? title + ' ' : '') + '[' + task.doi.replace(/[\/\\:]/g,'_') + '].pdf';
}
async function googleJson(http, url, init) {
  const response = await http(url,{redirect:'error',signal:AbortSignal.timeout(90000),...init});
  const body = await readJson(response);
  if (!response.ok) { const error = new Error(response.status === 401 || response.status === 403 ? 'drive_denied' : 'drive_unavailable'); error.status = response.status; throw error; }
  return body;
}
async function driveToken(env, http) {
  const form = new URLSearchParams({client_id:env.GDRIVE_CLIENT_ID,client_secret:env.GDRIVE_CLIENT_SECRET,refresh_token:env.GDRIVE_REFRESH_TOKEN,grant_type:'refresh_token'});
  const body = await googleJson(http,'https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form.toString()});
  if (typeof body.access_token !== 'string' || !body.access_token) throw new Error('drive_denied');
  return body.access_token;
}
async function driveUpload(env, http, token, task, bytes) {
  const auth = {authorization:'Bearer ' + token}, md5 = crypto.createHash('md5').update(bytes).digest('hex');
  // Drive always reports md5Checksum for uploaded binaries; sha256Checksum is checked too whenever Drive returns it.
  const same = f => f && f.md5Checksum === md5 && Number(f.size) === task.bytes && (!f.sha256Checksum || f.sha256Checksum === task.sha256);
  // A rerun after a crash reuses the file it already uploaded instead of creating a duplicate.
  const q = "'" + env.GDRIVE_FOLDER_ID + "' in parents and trashed = false and appProperties has { key='xinzhiSha256' and value='" + task.sha256 + "' }";
  const found = await googleJson(http,DRIVE + '?' + new URLSearchParams({q,fields:'files(id,size,md5Checksum,sha256Checksum)',supportsAllDrives:'true',includeItemsFromAllDrives:'true',pageSize:'5'}),{method:'GET',headers:auth});
  let file = (Array.isArray(found.files) ? found.files : []).find(same);
  if (!file) {
    const boundary = 'xinzhi' + crypto.randomBytes(12).toString('hex');
    const metadata = {name:driveName(task),mimeType:'application/pdf',parents:[env.GDRIVE_FOLDER_ID],appProperties:{xinzhiSha256:task.sha256,xinzhiDoi:task.doi.slice(0,100)}};
    const body = Buffer.concat([Buffer.from('--' + boundary + '\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + '\r\n--' + boundary + '\r\ncontent-type: application/pdf\r\n\r\n'),bytes,Buffer.from('\r\n--' + boundary + '--\r\n')]);
    file = await googleJson(http,UPLOAD + '&fields=id,size,md5Checksum,sha256Checksum',{method:'POST',headers:{...auth,'content-type':'multipart/related; boundary=' + boundary},body});
  }
  if (typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(file.id) || !same(file)) throw new Error('drive_integrity');
  // The inbox must stay private: never report a copy that anyone or a whole domain can open.
  const shared = await googleJson(http,DRIVE + '/' + file.id + '?' + new URLSearchParams({fields:'permissions(type)',supportsAllDrives:'true'}),{method:'GET',headers:auth});
  if (!Array.isArray(shared.permissions) || shared.permissions.some(p => ['anyone','domain'].includes(p.type))) throw new Error('drive_acl_public');
  return file.id;
}
async function runArchive(env = process.env, http = fetch, log = console.log, wait = ms => new Promise(r => setTimeout(r,ms))) {
  const missing = ['GDRIVE_CLIENT_ID','GDRIVE_CLIENT_SECRET','GDRIVE_REFRESH_TOKEN','GDRIVE_FOLDER_ID'].filter(k => !env[k]);
  if (missing.length) { log('::warning::Drive archive is not configured (' + missing.join(', ') + '); nothing was copied.'); log(JSON.stringify({archived:0,skipped:'drive_not_configured'})); return 0; }
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(env.GDRIVE_FOLDER_ID)) throw new Error('drive_bad_folder');
  await ready(ENDPOINT,'drive_bad_request',http,wait,1);
  const call = async (input, binary = false) => {
    const token = await identityToken(env,http,ENDPOINT);
    const response = await http(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90000),
      headers:{authorization:'Bearer ' + token,'content-type':'application/json','user-agent':'XinZhiDriveArchive/1.0'},body:JSON.stringify(input)});
    if (binary && response.ok && response.headers.get('content-type') === 'application/pdf') {
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) throw new Error('invalid_original'); chunks.push(chunk); }
      return Buffer.concat(chunks,size);
    }
    const body = await readJson(response);
    if (!response.ok || body.ok !== true) throw serviceError(response.status === 503 && body.error === 'library_sync_pending' ? 'archive_sync_pending' : 'archive_unavailable',response,body,token,ENDPOINT,'drive-archive.yml');
    if (binary) throw new Error('invalid_original');
    return body;
  };
  if (env.DRIVE_BACKFILL === 'true') {
    if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('invalid_backfill');
    let cursor = null, added = 0;
    for (let page = 0; page < 200; page++) {
      const result = await call({action:'backfill',...(cursor ? {cursor} : {})});
      added += Number.isInteger(result.added) ? result.added : 0; cursor = result.cursor;
      if (!cursor) break;
    }
    log(JSON.stringify({backfill:added}));
  }
  const token = await driveToken(env,http);
  let archived = 0;
  for (let n = 0; n < PER_RUN; n++) {
    const task = (await call({action:'claim'})).task;
    if (task === null) break;
    if (!task || !validDoi(task.doi) || typeof task.title !== 'string' || task.title.length > 800 || !/^[a-f0-9]{64}$/.test(task.sha256 || '')
        || !Number.isInteger(task.bytes) || task.bytes < 8 || task.bytes > MAX_BYTES) throw new Error('invalid_task');
    const bytes = await call({action:'bytes',doi:task.doi,sha256:task.sha256},true);
    if (bytes.length !== task.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== task.sha256) throw new Error('invalid_original');
    const driveFileId = await driveUpload(env,http,token,task,bytes);
    const done = await call({action:'complete',doi:task.doi,sha256:task.sha256,driveFileId});
    if (done.doi !== task.doi) throw new Error('invalid_task');
    archived++;
    log(JSON.stringify({doi:task.doi,drive:'archived'}));
  }
  log(JSON.stringify({archived,scope:'library_originals_to_drive_inbox'}));
  return archived;
}
module.exports = {runArchive,driveName};
if (require.main === module) runArchive().catch(error => {
  const known = ['invalid_task','invalid_original','invalid_backfill','drive_bad_folder','drive_denied','drive_unavailable','drive_integrity','drive_acl_public','archive_sync_pending','website_not_ready','website_denied','oidc_unavailable','response_too_large','invalid_json_response'];
  console.error(failureLog(error,known.includes(error.message) ? error.message : 'archive_unavailable')); process.exitCode = 1;
});
