import {runDesktop} from './desktop.mjs';
import {sessions,brief} from './sessions.mjs';
import * as lark from '@larksuiteoapi/node-sdk';
import {readFileSync,writeFileSync,renameSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {classify,newJob,runCodex,claimCard} from './core.mjs';

const home=process.env.FEISHU_CODEX_HOME||join(homedir(),'Library','Application Support','FeishuCodexBridge');
const configFile=join(home,'config.json'),stateFile=join(home,'state.json');
function save(path,value){const tmp=path+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});renameSync(tmp,path);}
if(!existsSync(configFile)){console.error('请先运行 npm run setup。');process.exit(1);}
const config=JSON.parse(readFileSync(configFile,'utf8'));
if(!config.appId||!config.appSecret||!existsSync(config.workspace)){console.error('应用凭证或工作目录无效，请重新运行 setup。');process.exit(1);}
mkdirSync(home,{recursive:true,mode:0o700});
const lockDir=join(home,'instance.lock');
try{mkdirSync(lockDir,{mode:0o700});}catch(e){
 if(e.code!=='EEXIST')throw e;
 let pid;try{pid=Number(readFileSync(join(lockDir,'pid'),'utf8'));}catch{}
 if(!Number.isInteger(pid)||pid<=0){console.error('发现未完成的实例锁，请先确认没有桥接程序运行，再删除 instance.lock。');process.exit(1);}
 let alive=true;try{process.kill(pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
 if(alive){console.error('已有桥接程序运行，拒绝重复启动。');process.exit(1);}
 rmSync(lockDir,{recursive:true});mkdirSync(lockDir,{mode:0o700});
}
writeFileSync(join(lockDir,'pid'),String(process.pid),{mode:0o600});
process.on('exit',()=>rmSync(lockDir,{recursive:true,force:true}));
const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{seen:{},sessions:{},jobs:[]};
// Never replay a possibly executed remote task after a crash.
for(const job of state.jobs)if(job.status==='running')job.status='interrupted';
state.cards ||= {};
save(stateFile,state);
const health={startedAt:new Date().toISOString(),connection:'starting',tokenCode:null};
function updateHealth(update){Object.assign(health,update);save(join(home,'health.json'),health);}
const client=new lark.Client({appId:config.appId,appSecret:config.appSecret,domain:lark.Domain.Feishu});
const ws=new lark.WSClient({appId:config.appId,appSecret:config.appSecret,domain:lark.Domain.Feishu,loggerLevel:lark.LoggerLevel.warn,handshakeTimeoutMs:15000,onReady:()=>{updateHealth({connection:'connected',connectedAt:new Date().toISOString()});console.log('飞书 WebSocket 已连接。');},onError:e=>{updateHealth({connection:'failed',error:e.message});console.error('飞书 WebSocket 连接失败：',e.message);},onReconnecting:()=>updateHealth({connection:'reconnecting'}),onReconnected:()=>updateHealth({connection:'connected',connectedAt:new Date().toISOString()})});
let active=false,closing=false;
function persist(){save(stateFile,state);}
async function reply(messageId,text){
  if(health.tokenCode===21001)throw new Error('飞书平台策略拒绝访问令牌（21001），回传暂停；任务结果会保存在本机。');
  // Split conservatively by Unicode code points; preserve all of the answer.
  const chars=Array.from(text);
  for(let i=0;i<chars.length;i+=2500){
    const res=await client.im.message.reply({path:{message_id:messageId},data:{msg_type:'text',content:JSON.stringify({text:chars.slice(i,i+2500).join('')}),uuid:createHash('sha256').update(messageId+'|'+text+'|'+i).digest('hex').slice(0,32)}});
    if(res.code!==0)throw new Error(`飞书回复失败 code=${res.code}`);
  }
}
async function drain(){
 if(active||closing)return;active=true;
 try{
  for(const job of state.jobs){
   if(closing)break;
   // Retry delivery, never re-execute a completed task.
   if(job.status==='reply_pending'){
    try{await reply(job.messageId,job.answer);job.status='done';persist();}catch(e){console.error(e.message);break;}
    continue;
   }
   if(job.status!=='pending')continue;
   job.status='running';persist();
   try{
    const session=job.sessionId||state.sessions[job.chatId];
    const target=session?await sessions(session):null;
    if(target?.status==='running')throw new Error('目标会话仍在执行，请等待结束后继续。');
    const taskConfig={...config,workspace:job.workspace||target?.cwd||config.workspace,taskTitle:job.text};
    const result=await runDesktop(taskConfig,session,
      job.text,{onThread:async(id,{forkedFrom}={})=>{job.sessionId=id;state.sessions[job.chatId]=id;if(forkedFrom)job.forkedFrom=forkedFrom;persist();if(forkedFrom)await reply(job.messageId,'原会话被桌面端占用，已保留原会话并复制上下文继续。新任务 ID：'+id).catch(e=>console.error(e.message));}});
    job.answer=result.answer;job.sessionId=result.thread;job.completedAt=new Date().toISOString();
    if(result.thread)state.sessions[job.chatId]=result.thread;
   }catch(e){console.error('Codex task failed:',e.message);job.answer='任务未完成：'+e.message;}
   job.status='reply_pending';persist();
   try{await reply(job.messageId,job.answer);job.status='done';persist();}catch(e){console.error(e.message);break;}
  }
 }finally{active=false;}
}
async function onMessage(data){
 const event=classify(data,config,state);
 if(event.kind==='ignore')return;
 const m=event.message;
 updateHealth({lastInboundAt:new Date().toISOString()});
 state.seen[m.message_id]=Date.now();
 if(event.kind==='pair'){
   config.ownerId=event.user;delete config.pairCode;save(configFile,config);persist();
   await reply(m.message_id,'配对成功。发文字即可调用 Mac 上的 Codex。/status 查看状态，/new 重置会话。');return;
 }
 if(event.text==='/status'){
  persist();
  const interrupted=state.jobs.filter(j=>j.status==='interrupted').length;
  await reply(m.message_id,`Mac 在线。工作目录：${config.workspace}\n等待任务：${state.jobs.filter(j=>j.status==='pending').length}\n执行中：${active}\n中断任务：${interrupted}\nCodex 会话：${state.sessions[m.chat_id]||'尚未创建'}`);return;
 }
 if(event.text==='/new'){
  persist();
  if(active||state.jobs.some(j=>j.status==='pending'||j.status==='reply_pending')){await reply(m.message_id,'请等待当前队列处理完成后再重置会话。');return;}
  delete state.sessions[m.chat_id];persist();await reply(m.message_id,'已切换到新会话模式。下一条任务会创建独立桌面聊天，标题以“飞书 · ”开头，旧会话保留。');return;
 }
 if(event.text==='/help'){
  persist();await reply(m.message_id,'/tasks 查看执行中及最近活跃的 5 个会话\n/brief 任务ID 查看简报\n/use 任务ID 选择会话，之后直接发消息继续\n/continue 任务ID 指令 继续指定会话\n/new 创建新会话\n/status 查看状态\n/panel 卡片测试');return;
 }
 if(event.text==='/tasks'||event.text==='任务列表'){
  persist();try{
   const list=await sessions();
   await reply(m.message_id,'执行中优先，其余按最近活跃排序（最多5个）：\n\n'+list.map((t,i)=>`${i+1}. ${t.status==='running'?'[执行中]':t.status==='idle'?'[轮次已结束]':'[状态未知]'} ${t.title.slice(0,100)}\nID：${t.id}\n更新：${new Date(t.updated_at*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`).join('\n\n')+'\n\n/brief 任务ID 查看简报；/use 任务ID 选择会话。执行状态来自本地记录，异常退出时可能滞后。');
  }catch(e){await reply(m.message_id,'读取任务失败：'+e.message);}return;
 }
 const cmd=event.text.match(/^\/(brief|use|continue)\s+(\S+)(?:\s+([\s\S]+))?$/);
 if(cmd){
  persist();try{
   const t=await sessions(cmd[2]);
   if(cmd[1]==='brief'){await reply(m.message_id,brief(t));return;}
   if(t.status!=='idle'){await reply(m.message_id,'该会话仍在执行或状态不明确，请等待当前轮次结束再继续。');return;}
   if(cmd[1]==='use'){
    if(active||state.jobs.some(j=>['pending','reply_pending'].includes(j.status))){await reply(m.message_id,'请等待当前队列完成后再切换会话。');return;}
    state.sessions[m.chat_id]=t.id;persist();await reply(m.message_id,'已选择：'+t.title.slice(0,160)+'\nID：'+t.id+'\n之后的文字消息将继续此会话。');return;
   }
   if(!cmd[3]){await reply(m.message_id,'用法：/continue 任务ID 后续指令');return;}
   if(state.jobs.filter(j=>['pending','running','reply_pending'].includes(j.status)).length>=20){await reply(m.message_id,'队列已满。');return;}
   const job=newJob(m,cmd[3],event.user);job.sessionId=t.id;job.workspace=t.cwd;
   state.jobs.push(job);persist();await reply(m.message_id,'已排队继续任务：'+t.id);void drain();
  }catch(e){await reply(m.message_id,'无法处理任务：'+e.message);}return;
 }
 if(event.text==='/panel'){
  persist();
  const nonce=randomBytes(16).toString('hex');
  const card={config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:'Mac Codex 连通性测试'}},elements:[{tag:'div',text:{tag:'plain_text',content:'点击后由你的 Mac 运行一次 Codex 测试。每张卡片只执行一次。'}},{tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:'运行 Codex 测试'},type:'primary',value:{bridge_nonce:nonce}}]}]};
  const res=await client.im.message.reply({path:{message_id:m.message_id},data:{msg_type:'interactive',content:JSON.stringify(card)}});
  if(res.code!==0)throw new Error('发送卡片失败 code='+res.code);
  state.cards[nonce]={chatId:m.chat_id,messageId:res.data.message_id};persist();return;
 }
 if(event.text.startsWith('/')){persist();await reply(m.message_id,'命令不完整或不存在。发送 /help 查看用法。');return;}
 if(event.text.length>20000){await reply(m.message_id,'消息太长，请拆成多条发送。');return;}
 if(state.jobs.filter(j=>['pending','running','reply_pending'].includes(j.status)).length>=20){await reply(m.message_id,'任务队列已满，请稍后重试。');return;}
 const job=newJob(m,event.text,event.user);job.sessionId=state.sessions[m.chat_id]||null;state.jobs.push(job);persist();
 await reply(m.message_id,'已收到，已加入 Mac 上的 Codex 任务队列。').catch(e=>console.error(e.message));
 void drain();
}
function onCard(data){
 const result=claimCard(data,config,state,closing);
 if(!result.ok)return {toast:{type:'error',content:result.error}};
 persist();void drain();return {toast:{type:'success',content:'已加入 Mac 的 Codex 队列。'}};
}
// Serialize receipt handling so duplicate deliveries cannot race pairing/queue persistence.
let inbox=Promise.resolve();
const dispatcher=new lark.EventDispatcher({}).register({
 'card.action.trigger':onCard,
 'im.message.receive_v1':data=>{inbox=inbox.then(()=>onMessage(data)).catch(e=>console.error('事件处理失败：',e.message));return {};},
});
console.log(`启动飞书 Codex 桥接。工作目录：${config.workspace}`);
if(!config.ownerId)console.log(`请在飞书私聊此应用机器人发送：/pair ${config.pairCode}`);
try{
 const res=await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:config.appId,app_secret:config.appSecret}),signal:AbortSignal.timeout(12000)});
 const data=await res.json();updateHealth({tokenCode:data.code,tokenMessage:data.msg,tokenLogId:res.headers.get('x-tt-logid')});
 if(data.code!==0)console.error('飞书访问令牌检查失败：',data.code,data.msg);
}catch(e){updateHealth({tokenCheckError:e.message});}
await ws.start({eventDispatcher:dispatcher});
void drain();
const retry=setInterval(()=>{if(health.tokenCode!==21001)void drain();},15000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{
 closing=true;clearInterval(retry);ws.close();
 // Finish the running task before stopping, preventing accidental replay.
 const stop=setInterval(()=>{if(!active){clearInterval(stop);process.exit(0);}},250);
});
