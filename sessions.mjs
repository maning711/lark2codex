import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function sessions(id){
 if(id&&!/^[0-9a-f-]{8,36}$/i.test(id))throw new Error('请使用至少 8 位的任务 ID。');
 try{const {stdout}=await exec('/usr/bin/python3',[new URL('./sessions.py',import.meta.url).pathname,'query',...(id?[id]:[])],{maxBuffer:2*1024*1024});return JSON.parse(stdout);}catch(e){try{throw new Error(JSON.parse(e.stdout).error);}catch(p){throw p;}}
}
export function brief(t){return `任务：${t.title.slice(0,200)}\nID：${t.id}\n状态：${t.status==='running'?'执行中（据本机记录）':t.status==='idle'?'当前轮次已结束':'未知'}\n目录：${t.cwd}\n\n最近请求：\n${t.latestRequest||'暂无可读取记录'}\n\n${t.status==='running'?'最新进展':'最近结果'}：\n${(t.status==='running'?t.progress:t.latestReply)||'暂无可读取记录'}\n\n/use ${t.id} 切换会话\n/continue ${t.id} 后续指令`}
