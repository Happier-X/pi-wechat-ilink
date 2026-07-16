# pi-wechat-ilink

Pi coding agent extension for the **official WeChat iLink / ClawBot** channel.

Use your phone WeChat to:

- send tasks to the current Pi session
- get notified when a local Pi task finishes
- approve or reject dangerous bash commands remotely

This is **not** Server酱 and **not** a WeChat Work webhook. It uses Tencent's official iLink gateway (`ilinkai.weixin.qq.com`) via the `@wechatbot/wechatbot` SDK.

## Install

### From local project (development)

```bash
pi install C:/code/pi-wechat-ilink
# or relative path
pi install ./pi-wechat-ilink
```

Or add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "C:/code/pi-wechat-ilink"
  ]
}
```

### From npm (after publish)

```bash
pi install npm:pi-wechat-ilink
```

### Quick test without install

```bash
pi -e C:/code/pi-wechat-ilink
```

Then restart Pi or run `/reload`.

## Usage

```text
/wechat              Connect WeChat iLink (QR on first login)
/wechat --force      Force re-login with a new QR code
/wechat-status       Connection status
/wechat-test         Send a test message to the last WeChat user
/wechat-stop         Disconnect (keeps saved credentials)
/weixin              Alias for /wechat
```

First connect:

1. Run `/wechat`
2. Scan the terminal QR code with WeChat
3. Confirm on your phone
4. Message the bot from WeChat, e.g. `检查当前项目测试为什么失败`

Credentials are stored under:

```text
~/.pi/agent/wechat-ilink-state/
```

Later starts usually reconnect without scanning again.

## WeChat control messages

```text
状态
待审批
批准 ABC123
拒绝 ABC123
```

Any other text is injected into the current Pi session as a user prompt. When Pi fully settles, the final answer is sent back to WeChat.

## Dangerous command approval

The extension intercepts high-risk bash patterns such as:

- `rm -rf`
- `sudo`
- `git push --force`
- `git reset --hard`
- `chmod/chown 777`
- `DROP TABLE/DATABASE`

WeChat receives an approval ID. Reply:

```text
批准 ABC123
拒绝 ABC123
```

Local UI confirmation and WeChat approval race; the first decision wins. Timeout defaults to reject after 5 minutes.

## How it works

```text
WeChat user
    │
    ▼
iLink API (Tencent)
    │
    ▼
pi-wechat-ilink extension
    │
    ├── WeChat text → pi.sendUserMessage()
    ├── agent_settled → reply final answer / completion notice
    └── tool_call (dangerous bash) → WeChat approve/reject
```

No public IP is required. The extension long-polls iLink.

## Develop

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/pi-wechat-ilink.git
cd pi-wechat-ilink
npm install
```

Point Pi at the local package:

```bash
pi install .
```

Edit `src/index.ts`, then in Pi:

```text
/reload
```

Typecheck:

```bash
npm run typecheck
```

## Publish

### GitHub

```bash
# replace remote URL first in package.json / git remote
git init
git add .
git commit -m "feat: initial pi wechat ilink extension"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/pi-wechat-ilink.git
git push -u origin main
```

Users can install from git:

```bash
pi install git:github.com/YOUR_GITHUB_USERNAME/pi-wechat-ilink
```

### npm

1. Update `repository` / `homepage` / `bugs` in `package.json`
2. Login:

```bash
npm login
```

3. Publish:

```bash
npm version patch
npm publish --access public
```

4. Install:

```bash
pi install npm:pi-wechat-ilink
```

## Security notes

- iLink credentials under `~/.pi/agent/wechat-ilink-state/` must not be committed or shared
- Anyone who can message the bot can inject tasks into the active Pi session
- Approval timeout defaults to reject
- Review dangerous command patterns before relying on them in production workflows

## License

MIT
