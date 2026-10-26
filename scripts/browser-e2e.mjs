#!/usr/bin/env node
// Dedicated browser regression instance; never uses the player's configuration.
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import net from 'node:net';
import {createWriteStream} from 'node:fs';
import {access, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = {apiPort:7822, webPort:5174, resources:path.join(app,'resources/models'), evidence:null, smoke:false, specs:[]};
for(let index=2;index<process.argv.length;index++){
  const flag=process.argv[index];
  if(flag==='--help'){
    console.log('Usage: node scripts/browser-e2e.mjs [--smoke] [--spec e2e/NN-name.spec.ts] [--api-port 7822] [--web-port 5174] [--resources-dir PATH] [--evidence-dir PATH]');process.exit(0);
  } else if(flag==='--smoke') options.smoke=true;
  else if(flag==='--spec'){
    const spec=process.argv[++index];
    if(!spec || !/^e2e\/[A-Za-z0-9._-]+\.spec\.ts$/.test(spec))throw new Error('Specs must be repository-relative e2e/*.spec.ts files');
    options.specs.push(spec);
  }
  else {
    const key={'--api-port':'apiPort','--web-port':'webPort','--resources-dir':'resources','--evidence-dir':'evidence'}[flag];
    const value=process.argv[++index];
    if(!key || !value) throw new Error('Unknown or incomplete browser test option');
    options[key]=key.endsWith('Port') ? (/^\d+$/.test(value) ? Number(value) : NaN) : path.resolve(value);
  }
}
if(![options.apiPort,options.webPort].every(value=>Number.isInteger(value)&&value>0&&value<65536) || options.apiPort===options.webPort)
  throw new Error('Use two different loopback ports between 1 and 65535');
const python=path.join(app,'backend/.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const frontend=path.join(app,'frontend');
const children=new Set(), streams=[];
let stopping=false;
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function freePort(port){
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(port,'127.0.0.1',resolve);});
  await new Promise(resolve=>probe.close(resolve));
}
function start(command,args,cwd,env,log){
  const output=createWriteStream(log);streams.push(output);
  const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});children.add(child);
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve(code??1));});
  // Retain failures until the caller awaits them, without an unhandled rejection.
  done.catch(()=>{});return {child,done};
}
async function stop(child){
  if(child.exitCode!==null || child.signalCode!==null || !child.pid) return;
  const terminate=signal=>{
    try{
      if(process.platform==='win32') spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
      else process.kill(-child.pid,signal); // Only the dedicated group created above.
    }catch(error){if(error.code!=='ESRCH')throw error;}
  };
  terminate('SIGTERM');
  for(let attempt=0;attempt<40&&child.exitCode===null&&child.signalCode===null;attempt++)await delay(100);
  if(child.exitCode===null&&child.signalCode===null){
    terminate('SIGKILL');
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1000)]);
  }
}
async function ready(url,owner){
  for(let attempt=0;attempt<120;attempt++){
    if(stopping) throw new Error('Browser regression run interrupted');
    if(owner.exitCode!==null || owner.signalCode!==null) throw new Error(`Isolated service exited; inspect its log: ${url}`);
    try{const response=await fetch(url,{signal:AbortSignal.timeout(1000)});await response.body?.cancel();if(response.ok)return;}catch{}
    await delay(250);
  }
  throw new Error(`Isolated service did not become ready: ${url}`);
}

const provider=createServer(async(req,res)=>{
  try{
    let body='';for await(const chunk of req){body+=chunk;if(body.length>1024*1024)throw new Error('Synthetic request is too large');}
    const input=JSON.parse(body||'{}');
    if(input.stream){
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'测试通过。'},index:0}]})+'\n\ndata: [DONE]\n\n');
    }else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'[]'}}]}));}
  }catch{res.writeHead(400);res.end();}
});
let interrupted;
const interruption=new Promise((_,reject)=>{interrupted=()=>{stopping=true;reject(new Error('Browser regression run interrupted'));};});
interruption.catch(()=>{});
process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
try{
  for(const file of [python,path.join(frontend,'node_modules/@playwright/test/cli.js'),path.join(frontend,'public/live2d/live2dcubismcore.min.js'),path.join(options.resources,'asr/manifest.json'),path.join(options.resources,'embedding/multilingual-e5-small/manifest.json')])await access(file);
  for(const spec of options.specs)await access(path.join(frontend,spec));
  await Promise.all([freePort(options.apiPort),freePort(options.webPort)]);
  const data=await mkdtemp(path.join(tmpdir(),'momo-browser-e2e-'));
  const evidence=options.evidence??path.join(app,'target/browser-e2e',path.basename(data));
  await mkdir(evidence,{recursive:true,mode:0o700});
  await new Promise((resolve,reject)=>{provider.once('error',reject);provider.listen(0,'127.0.0.1',resolve);});
  const providerUrl=`http://127.0.0.1:${provider.address().port}`;
  const env={...process.env,MOMO_DATA_DIR:data,MOMO_RESOURCES_DIR:options.resources};
  for(const key of ['MOMO_DESKTOP_TOKEN','MOMO_DESKTOP_NONCE','MOMO_REAL_LLM_E2E','MOMO_REAL_TTS_E2E','MOMO_REAL_ONBOARDING_E2E','MOMO_BROWSER_LLM_CONFIG','MOMO_E2E_LLM_CONFIG','MOMO_ASR_MODELS'])delete env[key];
  const seed=`import sys\nfrom app.core import state,db\nfrom app.services import checkpoint\nstate.write_state({'settings':{'llm':{'url':sys.argv[1],'model':'deterministic','key':''},'general':{'lang':'zh','voiceInput':False,'textSpeed':100,'sentenceSpeed':100}}})\nat=db.now_iso();gen=checkpoint.generation()\ncheckpoint.begin_turn('隔离测试会话',gen,at)\ncheckpoint.append_sentence('欢迎回来。',gen,at)\ncheckpoint.acknowledge(checkpoint.current_run(gen,at),'欢迎回来。',gen)\ndb.reset()`;
  if(await start(python,['-c',seed,providerUrl],path.join(app,'backend'),env,path.join(evidence,'seed.log')).done!==0)throw new Error('Could not seed synthetic test profile');
  const backend=start(python,['-m','uvicorn','app.main:app','--host','127.0.0.1','--port',String(options.apiPort)],path.join(app,'backend'),env,path.join(evidence,'backend.log'));
  const web=start(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(options.webPort),'--strictPort'],frontend,{...env,MOMO_WEB_API_UPSTREAM:`http://127.0.0.1:${options.apiPort}`,MOMO_WEB_LLM_UPSTREAM:providerUrl,MOMO_WEB_ASR_UPSTREAM:providerUrl,MOMO_WEB_TTS_UPSTREAM:providerUrl},path.join(evidence,'frontend.log'));
  const baseURL=`http://127.0.0.1:${options.webPort}`;
  await Promise.race([Promise.all([ready(`http://127.0.0.1:${options.apiPort}/api/health`,backend.child),ready(baseURL,web.child)]),interruption]);
  await writeFile(path.join(evidence,'instance.json'),JSON.stringify({dataDir:data,baseURL,provider:'synthetic loopback only',realProviderOptIns:false},null,2));
  console.log(`Browser regression instance: ${baseURL}\nSynthetic data: ${data}\nEvidence: ${evidence}`);
  const args=['node_modules/@playwright/test/cli.js','test','--output',path.join(evidence,'test-results')];
  if(options.smoke)args.push('e2e/01-smoke.spec.ts');
  else args.push(...options.specs);
  const run=start(process.execPath,args,frontend,{...env,MOMO_E2E_BASE_URL:baseURL},path.join(evidence,'playwright.log'));
  run.child.stdout.pipe(process.stdout);run.child.stderr.pipe(process.stderr);
  process.exitCode=await Promise.race([run.done,interruption]);
}catch(error){console.error(`Browser regressions failed: ${error.message}`);process.exitCode=1;}
finally{
  stopping=true;
  for(const child of [...children].reverse())await stop(child);
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
  for(const stream of streams)stream.end();
  process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
}
