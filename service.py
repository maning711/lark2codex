#!/usr/bin/env python3
import os,plistlib,shutil,subprocess,sys,json
from pathlib import Path
root=Path(__file__).resolve().parent
home=Path(os.environ.get('FEISHU_CODEX_HOME',Path.home()/'Library/Application Support/FeishuCodexBridge'))
label='local.feishu-codex-bridge'
plist=Path.home()/'Library/LaunchAgents'/f'{label}.plist'
domain=f'gui/{os.getuid()}'
action=sys.argv[1] if len(sys.argv)>1 else 'status'
if action in ('install','uninstall') and (home/'state.json').exists():
    state=json.loads((home/'state.json').read_text())
    if any(j.get('status')=='running' for j in state.get('jobs',[])):
        raise SystemExit('当前有任务执行中，拒绝重启或卸载。请等待任务完成后再操作。')
if action=='install':
    if not (home/'config.json').exists():raise SystemExit('请先运行 npm run setup。')
    node=shutil.which('node')
    if not node:raise SystemExit('找不到 Node。')
    plist.parent.mkdir(parents=True,exist_ok=True)
    spec={'Label':label,'ProgramArguments':[node,str(root/'bridge.mjs')],'WorkingDirectory':str(root),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':30,'ExitTimeOut':960,'EnvironmentVariables':{'PATH':os.environ['PATH'],'FEISHU_CODEX_HOME':str(home)},'StandardOutPath':str(home/'service.log'),'StandardErrorPath':str(home/'error.log')}
    if plist.exists():subprocess.run(['launchctl','bootout',domain,str(plist)],capture_output=True)
    with plist.open('wb') as f:plistlib.dump(spec,f)
    subprocess.run(['launchctl','bootstrap',domain,str(plist)],check=True)
    print('已启用登录后自动启动。日志：',home)
elif action=='uninstall':
    subprocess.run(['launchctl','bootout',domain,str(plist)],capture_output=True)
    plist.unlink(missing_ok=True)
    print('自动启动已移除，配置和任务记录保留。')
elif action=='status':
    subprocess.run(['launchctl','print',f'{domain}/{label}'])
else:raise SystemExit('用法：python3 service.py install|status|uninstall')
