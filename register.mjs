import * as lark from '@larksuiteoapi/node-sdk';
import {mkdirSync,writeFileSync,renameSync,readFileSync,existsSync,chmodSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const home=process.env.FEISHU_CODEX_HOME||join(homedir(),'Library','Application Support','FeishuCodexBridge');
const path=join(home,'config.json');
if(existsSync(path)){console.error('本机已有配置；请用 npm run setup 修改，避免重复创建应用。');process.exit(1);}
const controller=new AbortController();
const timer=setTimeout(()=>controller.abort(),12*60*1000);
try{
 const result=await lark.registerApp({
  signal:controller.signal,createOnly:true,source:'mac-codex-bridge',
  appPreset:{name:'Mac Codex 助手',desc:'将飞书私聊和卡片交互连接至本机 Codex'},
  addons:{preset:false,scopes:{tenant:['im:message.p2p_msg:readonly','im:message:send_as_bot']},events:{items:{tenant:['im.message.receive_v1']}},callbacks:{items:['card.action.trigger']}},
  onQRCodeReady(info){console.log(JSON.stringify({authorization_url:info.url,expires_in_seconds:info.expireIn}));}
 });
 mkdirSync(home,{recursive:true,mode:0o700});
 const codex=execFileSync('/bin/zsh',['-lc','command -v codex'],{encoding:'utf8'}).trim();
 const config={appId:result.client_id,appSecret:result.client_secret,workspace:process.env.CODEX_WORKSPACE||process.cwd(),codexBin:codex,timeoutSeconds:900};
 if(result.user_info?.open_id)config.ownerId=result.user_info.open_id;
 else config.pairCode=randomBytes(12).toString('hex');
 writeFileSync(path+'.tmp',JSON.stringify(config,null,2),{mode:0o600});renameSync(path+'.tmp',path);chmodSync(path,0o600);
 console.log('应用授权完成，凭证已保存到本机私有目录。');
 console.log('APP_ID='+config.appId);
 if(config.pairCode)console.log('PAIR_COMMAND=/pair '+config.pairCode);
}catch(e){console.error('注册未完成：',e.code||e.message);process.exitCode=1;}finally{clearTimeout(timer);}
