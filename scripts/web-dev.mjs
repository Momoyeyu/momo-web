// Own exactly the processes started by this launcher. Never kill a port owner.
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.resolve(process.env.MOMO_DATA_DIR || path.join(root, '.workbuddy/dev-data'));
const apiPort = Number(process.env.MOMO_API_PORT || 7821);
const webPort = Number(process.env.MOMO_WEB_PORT || 5173);
const resources = path.resolve(process.env.MOMO_RESOURCES_DIR || path.join(root, 'resources/models'));
const python = path.join(root, 'backend/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const children = [];
let closing = false;
let ownsLock = false;
function stop(code=0) {
  if (closing) return;
  closing = true;
  for (const child of children) {
    try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch {}
  }
  setTimeout(() => {
    for (const child of children) {try { process.platform === 'win32' ? child.kill('SIGKILL') : process.kill(-child.pid,'SIGKILL'); } catch {}}
    if(ownsLock)try {if(readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);} catch {}
    process.exit(code);
  }, 1500);
}
const lock = path.join(data, '.web-dev.lock');
async function unused(port) {
  await new Promise((resolve,reject) => {
    const server=net.createServer(); server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>server.close(resolve));
  });
}
function launch(command,args,cwd,env) {
  const child=spawn(command,args,{cwd,env,stdio:'inherit',detached:process.platform!=='win32'});
  children.push(child);
  child.once('error',error=>{console.error(error.message);stop(1)});
  child.once('exit',code=>{if(!closing)stop(code||1)});
  return child;
}
try {
  if (!existsSync(python) || !existsSync(path.join(root,'frontend/node_modules/vite/bin/vite.js')))
    throw Error('Install locked dependencies first: cd backend && uv sync --frozen; cd ../frontend && pnpm install --frozen-lockfile');
  if (!existsSync(path.join(resources,'resource-manifest.json')) || !existsSync(path.join(root,'frontend/public/live2d/live2dcubismcore.min.js')))
    throw Error('Offline resources missing. Run the documented prepare-models.py and prepare-core.py before starting. Runtime never downloads models.');
  await unused(apiPort); await unused(webPort);
  mkdirSync(data,{recursive:true,mode:0o700});
  if (existsSync(lock)) {
    const pid=Number(readFileSync(lock,'utf8'));
    try {process.kill(pid,0); throw Error('A Web launcher already owns this data directory');}
    catch(error) {if(error.code!=='ESRCH')throw error; unlinkSync(lock);}
  }
  const fd=openSync(lock,'wx',0o600); writeFileSync(fd,String(process.pid));closeSync(fd);
  ownsLock=true;
  const token=randomBytes(32).toString('hex');
  const origin=`http://127.0.0.1:${webPort}`;
  const env={...process.env,MOMO_DATA_DIR:data,MOMO_RESOURCES_DIR:resources,MOMO_DESKTOP_TOKEN:token,MOMO_WEB_ORIGIN:origin,MOMO_WEB_API_UPSTREAM:`http://127.0.0.1:${apiPort}`};
  process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
  launch(python,['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(apiPort)],path.join(root,'backend'),env);
  let ready=false;
  for(let i=0;i<100&&!closing;i++) {
    try {const r=await fetch(`${env.MOMO_WEB_API_UPSTREAM}/api/health`,{headers:{'x-momo-token':token}});if(r.ok){ready=true;break}}
    catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  if(!ready)throw Error('Backend did not become ready');
  launch(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(webPort),'--strictPort'],path.join(root,'frontend'),env);
  console.log(`momo Web: ${origin} (isolated development profile)`);
} catch(error) {console.error(error.message);stop(1)}
