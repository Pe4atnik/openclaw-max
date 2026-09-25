# @olegbalbekov/openclaw-max

MAX messenger (max.ru) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw).

## Features

- DM and group chat support
- Long polling (default) and webhook modes
- Live status updates (Telegram-style): a placeholder reply that shows work in
  progress — thinking, per-tool activity, approval waits — and is cleaned up on
  silent replies
- Forwarded messages: incoming forwards are unwrapped and passed to the agent
- Media sending and receiving (images), including screenshots and images from
  forwarded messages, saved to `~/.openclaw/media/inbound`
- Allowlist-based access control

## Installation

### 1. Install the plugin

```bash
openclaw plugins install @olegbalbekov/openclaw-max
```

Or manually — clone/copy the plugin directory into `~/.openclaw/extensions/max/` and add to your config:

```json5
{
  plugins: {
    load: {
      paths: ["~/.openclaw/extensions/max"]
    },
    entries: {
      max: { enabled: true }
    }
  }
}
```

> **Important:** Do NOT add `plugins.allow` unless you explicitly need it. When `plugins.allow` is set, it acts as a strict allowlist and will block all bundled plugins (including Telegram) that are not listed. Use `plugins.entries` instead to enable/disable individual plugins.

### 2. Get a MAX bot token

1. Go to [business.max.ru](https://business.max.ru) and create a bot
2. Copy the bot token

### 3. Configure OpenClaw

Add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    max: {
      enabled: true,
      token: "YOUR_BOT_TOKEN_HERE",
      dmPolicy: "allowlist",         // "open" | "allowlist" | "closed"
      allowFrom: ["YOUR_USER_ID"],   // MAX user IDs — must be strings
    }
  },
  bindings: [
    {
      agentId: "main",
      match: { channel: "max", accountId: "default" }
    }
  ]
}
```

### 4. Restart the gateway

```bash
sudo systemctl restart openclaw
# or
openclaw gateway restart
```

### 5. Verify

```bash
openclaw channels status
```

Should show: `MAX default: enabled, dm:allowlist, allow:YOUR_USER_ID`

## Configuration reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token` | string \| SecretRef | required | MAX Bot API token, plain or a SecretRef (see below) |
| `enabled` | boolean | `true` | Enable/disable channel |
| `dmPolicy` | string | `"allowlist"` | DM access policy: `open`, `allowlist`, `closed` |
| `allowFrom` | string[] | `[]` | MAX user IDs allowed to DM (when dmPolicy=allowlist) |
| `groupPolicy` | string | `"allowlist"` | Group chat access policy: `open`, `allowlist`, `closed` |
| `groupAllowFrom` | string[] | `[]` | MAX user IDs allowed in group chats (when groupPolicy=allowlist) |
| `webhookUrl` | string | — | Webhook URL (optional, uses long polling if not set) |
| `webhookSecret` | string | — | Webhook secret for request verification |
| `httpProxy` | string | — | Optional HTTP(S) proxy for MAX API traffic, e.g. `http://user:pass@host:port` |

### Token as a SecretRef

Instead of the plain token, `token` (at the channel level or in `accounts.<id>`)
can point to a secret the gateway resolves at startup, so the config file holds
no credential:

```json5
{
  channels: {
    max: {
      token: { source: "exec", provider: "my-keychain", id: "max-bot-token" },
      // or { source: "env", provider: "default", id: "MAX_BOT_TOKEN" }
    }
  }
}
```

The provider is declared under `secrets.providers`. If the reference cannot be
resolved, the gateway marks the account unavailable and the plugin does not start
it; the log names the unresolved reference. Check with `openclaw secrets audit`.

## MAX API migration (July 2026)

As of **2026-07-19** MAX decommissioned the legacy `platform-api.max.ru` host. This
plugin (v0.5.0+) talks to the new `platform-api2.max.ru` endpoint. That host serves
a TLS chain anchored on the **Russian Trusted Root CA (Минцифры)**, which is not in
Node's bundled certificate store — so the plugin ships that CA and trusts it
automatically (on top of the default roots). No manual `NODE_EXTRA_CA_CERTS` setup
is required. Bot tokens are sent via the `Authorization` header, as the new API
mandates.

If your gateway has no direct route to `platform-api2.max.ru`, set `httpProxy` to
tunnel all MAX traffic through a proxy.

## OpenClaw 2026.8+ compatibility

Since **v0.6.0** the plugin runs on OpenClaw 2026.8+ cores: it no longer calls the
renamed `config.loadConfig` and derives session keys through the core route
resolver (canonical keys) instead of a flat `max:<senderId>`.

> **Upgrade note:** the session-key change means active MAX dialogs are re-keyed
> once on the first restart after upgrading — ongoing conversations start a fresh
> session history that one time. This is expected, not a bug.

## Webhook mode (optional)

Long polling processes updates in order and retries a failed update up to three
times before leaving the batch marker unchanged. A later poll can therefore
redeliver the batch. This favors no loss, but an update completed before the
failure can be delivered more than once; handlers should remain idempotent where
possible.

For production, configure a webhook instead of long polling:

```json5
{
  channels: {
    max: {
      token: "YOUR_BOT_TOKEN",
      webhookUrl: "https://your-domain.com/api/channels/max/webhook",
      webhookSecret: "your-secret"
    }
  }
}
```

## Troubleshooting

**Plugin not starting / `channels.max: unknown channel id`**

- Make sure `plugins.allow` is NOT set (or includes `"max"` explicitly)

**Telegram stops working after adding MAX**

- Do NOT set `plugins.allow: ["max"]` — this blocks all other plugins including Telegram
- Use `plugins.entries.max.enabled: true` instead

**Gateway won't start**

- Validate config JSON: `python3 -c "import json; json.load(open('~/.openclaw/openclaw.json'))"`
- Check logs: `journalctl -u openclaw -n 50`

## Supported by

Supported by [Evrone](https://evrone.com/?utm_source=openclaw-max) — a software development company that builds products and helps companies improve their development processes.

<a href="https://evrone.com/?utm_source=openclaw-max">
  <img src="https://user-images.githubusercontent.com/417688/34437029-dbfe4ee6-ecab-11e7-9d80-2b274b4149b3.png"
       alt="Sponsored by Evrone" width="231" />
</a>

## License

MIT © [Oleg Balbekov](https://github.com/olegbalbekov)
