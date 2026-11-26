import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const home=process.env.FEISHU_CODEX_HOME||join(homedir(),'Library','Application Support','FeishuCodexBridge');
const cfg=join(home,'config.json');
if(!existsSync(cfg)){console.log('未配置，请运行 npm run register 或 npm run setup。');process.exit(1);}
const c=JSON.parse(readFileSync(cfg));
const health=existsSync(join(home,'health.json'))?JSON.parse(readFileSync(join(home,'health.json'))):null;
const state=existsSync(join(home,'state.json'))?JSON.parse(readFileSync(join(home,'state.json'))):null;
const report={checkedAt:new Date().toISOString(),appId:c.appId,ownerBound:!!c.ownerId,health,receivedMessages:state?Object.keys(state.seen).length:0,jobs:state?.jobs.map(j=>({id:j.id,status:j.status,hasAnswer:!!j.answer}))};
try{
 const response=await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({app_id:c.appId,app_secret:c.appSecret}),signal:AbortSignal.timeout(12000)});
 const d=await response.json();report.tokenCheck={httpStatus:response.status,code:d.code,message:d.msg,logId:response.headers.get('x-tt-logid')};
}catch(e){report.tokenCheck={error:e.message};}
console.log(JSON.stringify(report,null,2));
if(report.tokenCheck.code===21001)console.log('当前应用被飞书平台访问策略拒绝。请检查账号/租户类型，或携带 logId 向飞书支持查询。权限已开通不代表令牌可用。');
process.exitCode=report.tokenCheck.code===0?0:1;
