// Private test launcher: real Cordis host/runtime, test-only SDK subprocess.
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PluginHost,HostError} from '../../src/host.mjs';
import {QQRuntimeManager} from '../../src/qq-runtime.mjs';
const fixture=fileURLToPath(new URL('./qq-full-native.cjs',import.meta.url));
const runtime=new QQRuntimeManager({createTransport:()=>spawn(process.execPath,[fixture,path.join(process.env.QQ_FIXTURE_ROOT,'native')],{stdio:['pipe','pipe','pipe']}),requestTimeoutMs:2000,stopTimeoutMs:1000,autoRetryDelayMs:50});
const write=message=>process.stdout.write(JSON.stringify(message)+'\n');
const host=new PluginHost({qqRuntime:runtime,emit:write,stopTimeoutMs:1000});
const input=createInterface({input:process.stdin,crlfDelay:Infinity});let closing=false;
async function close(){if(closing)return;closing=true;input.close();await host.close();process.exit(0);}
input.on('line',line=>{if(closing)return;let packet;try{packet=JSON.parse(line);}catch{return;}void host.request(packet).then(result=>{write({v:1,id:packet.id,ok:true,result});if(packet.method==='shutdown')void close();},error=>write({v:1,id:packet.id,ok:false,error:{code:error instanceof HostError?error.code:'INTERNAL',message:'Fixture operation failed'}}));});
input.on('close',()=>void close());process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
