import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,existsSync,readFileSync,renameSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [source,destination]=process.argv.slice(2);
if(!source||!destination)throw new Error('Usage: node --experimental-sqlite scripts/restore.mjs <backup.sqlite> <new-output.sqlite>. Stop the service before replacing its database.');
const input=path.resolve(source),output=path.resolve(destination);
if(existsSync(output)||existsSync(output+'-wal')||existsSync(output+'-shm'))throw new Error('Destination must be a new file; existing data is never overwritten.');
const manifest=JSON.parse(readFileSync(input+'.json','utf8'));
if(createHash('sha256').update(readFileSync(input)).digest('hex')!==manifest.sha256)throw new Error('Backup checksum mismatch');
const stage=output+'.restoring';
if(existsSync(stage))throw new Error('Temporary destination already exists');
copyFileSync(input,stage);
try{
 const db=new DatabaseSync(stage);
 try{
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Integrity check failed');
  // Restored sessions and queued work must not resume with stale authority.
  db.exec("DELETE FROM auth_sessions; UPDATE jobs SET status='cancelled',message='从备份恢复，请重新提交' WHERE status IN ('queued','running'); UPDATE runs SET status='error',message='从备份恢复，请重新同步' WHERE status='running'; UPDATE accounts SET status='error',error='从备份恢复，请检测登录状态' WHERE status IN ('syncing','binding'); PRAGMA wal_checkpoint(TRUNCATE);");
 }finally{db.close();}
 renameSync(stage,output);console.log('Verified restore created: '+output);
}catch(e){if(existsSync(stage))unlinkSync(stage);throw e;}
