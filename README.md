# pi-usage

Pi footer quota for three accounts already stored in `~/.pi/agent/auth.json`:

| Source | Credential | Endpoint |
|---|---|---|
| DeepSeek | `deepseek` API key | `GET https://api.deepseek.com/user/balance` |
| OpenCode Go | `opencode-go` API key | `GET https://opencode.ai/zen/go/v1/usage` |
| Grok | `xai` OAuth access token | unofficial `cli-chat-proxy.grok.com` billing |

The footer shows a compact line such as `DS $12.40  Go 49%  Grok —`. Run `/usage` for reset times. Results are cached for 60 seconds and refresh on session start and turn end.

Grok's billing route is not a public xAI API. A missing percent is shown as `—` rather than invented as zero. An expired access token needs `/login xai`; this package does not refresh tokens itself.

## Install

From a git remote:

```bash
pi install git:github.com/you/pi-usage
```

From this checkout, without copying:

```bash
pi install /Users/barkure/Projects/pi-usage
```
