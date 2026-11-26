#!/usr/bin/env python3
"""Interactive setup: secrets are entered locally, never in chat."""
import getpass,json,os,secrets,shutil
from pathlib import Path
home=Path(os.environ.get('FEISHU_CODEX_HOME',Path.home()/'Library/Application Support/FeishuCodexBridge'))
home.mkdir(parents=True,exist_ok=True,mode=0o700)
path=home/'config.json'
old=json.loads(path.read_text()) if path.exists() else {}
def ask(label,key,default=''):
    existing=old.get(key,default)
    return input(f'{label} [{existing}]: ').strip() or existing
app_id=ask('飞书 App ID','appId')
secret=getpass.getpass('飞书 App Secret（隐藏输入，留空保留）: ') or old.get('appSecret','')
workspace=Path(ask('Codex 工作目录','workspace',str(Path.cwd()))).expanduser().resolve()
codex=ask('Codex 可执行文件','codexBin',shutil.which('codex') or '')
if not app_id.startswith('cli_') or not secret:raise SystemExit('请填写有效 App ID 和 App Secret。')
if not workspace.is_dir() or not Path(codex).is_file():raise SystemExit('工作目录或 Codex 路径不存在。')
config={**old,'appId':app_id,'appSecret':secret,'workspace':str(workspace),'codexBin':codex,'timeoutSeconds':900}
if not config.get('ownerId'):config['pairCode']=old.get('pairCode') or secrets.token_hex(12)
fd=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump(config,f,ensure_ascii=False,indent=2)
os.chmod(path,0o600)
print('配置已保存到本机私有目录。下一步运行 npm start。')
if config.get('pairCode'):print('机器人启动后，在飞书私聊发送：/pair '+config['pairCode'])
