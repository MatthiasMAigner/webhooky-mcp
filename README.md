# webhooky-mcp

An [MCP](https://modelcontextprotocol.io) server for [Webhooky](https://webhooky.app).

Gives an AI assistant one ability: **send a push notification to your phone.**
Useful when you ask it to do something long-running and then walk away, it can
tell you itself instead of writing code that tells you.

```
You:  Run the migration and let me know when it's done.
Claude: [runs it, then calls send_notification]
📱      ✅ Migration done · 14,203 rows · 6m12s
```

## Setup

Install the Webhooky app ([iOS](https://apps.apple.com/app/id6754565668) ·
[Android](https://play.google.com/store/apps/details?id=app.webhooky)), create an
endpoint and copy its URL. No account needed, the URL exists the moment the app
opens. The free plan covers 100 notifications per month across up to 3 endpoints.

### Claude Code

```bash
claude mcp add webhooky -e WEBHOOKY_URL=https://api.webhooky.app/YOUR_KEY -- npx -y webhooky-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "webhooky": {
      "command": "npx",
      "args": ["-y", "webhooky-mcp"],
      "env": { "WEBHOOKY_URL": "https://api.webhooky.app/YOUR_KEY" }
    }
  }
}
```

### Cursor, Zed and other MCP clients

Same shape: command `npx`, args `["-y", "webhooky-mcp"]`, and `WEBHOOKY_URL` in
the environment.

## Tools

### `send_notification`

| Argument  | Type    | Required | Notes |
|-----------|---------|----------|-------|
| `title`   | string  | yes      | Max 100 characters |
| `message` | string  | no       | Max 500 characters. Omit to use the endpoint's configured text |
| `sound`   | enum    | no       | One of the 40 sound ids. Omit to use the endpoint's sound |
| `vibrate` | boolean | no       | Overrides the endpoint's vibration setting |

Returns a confirmation including how many devices it reached. It reports an
error, rather than a cheerful success, when the notification was **accepted
but not delivered**, which is what happens when the free plan's monthly quota is
used up. Webhooky answers HTTP 200 in that case on purpose, so that senders like
Stripe don't retry, and this server unpacks that distinction for you.

### `list_sounds`

The 40 sounds grouped by meaning (money, success, failure, informational,
attention-grabbing, playful), so the assistant can pick one that matches the
event instead of guessing from an id.

## Configuration

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `WEBHOOKY_URL` | yes | (none) | Your full endpoint URL, key included |
| `WEBHOOKY_TIMEOUT_MS` | no | `10000` | Request timeout |

`WEBHOOKY_URL` must be `https`, except on `localhost` / `127.0.0.1`, where plain
`http` is allowed because nothing leaves the machine.

## A note on your URL

Your endpoint URL can do exactly one thing: trigger a notification on your phone.
It cannot read your history, reach your account or expose any data. Anyone who
knows it can send you notifications, and that is the whole blast radius.
This server therefore takes it **only** from
the environment, never as a tool argument: a model can't be talked into sending
to a different endpoint, and the key never enters the conversation. It is also
stripped from any error message before it is returned.

Treat `WEBHOOKY_URL` the way you would a Slack incoming webhook URL: keep it out
of public repositories, but it is not a password. If it leaks, delete the endpoint in the app and create a new one. The old URL
dies instantly.

## Development

```bash
npm install
npm test     # drives the server over real stdio against a stub endpoint
```

## Links

- [Integration contract for AI agents](https://webhooky.app/ai)
- [OpenAPI 3.1 specification](https://webhooky.app/openapi.yaml)
- [API documentation](https://webhooky.app/docs)

MIT · [Aigner Software e.U.](https://webhooky.app)
