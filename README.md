# jefr cursor

English-localized Cursor IDE extension for side-panel chat via **Model Context Protocol (MCP)**.

## Quick start

See [QUICKSTART.txt](QUICKSTART.txt).

1. Install `jefr-cursor.vsix` in Cursor Extensions
2. Restart Cursor
3. Enable **jefr cursor** under Settings → Tools & MCP
4. Send `Hello` once in native chat to start the loop
5. Continue from the **jefr cursor** bottom panel

## Repository layout

```
extension/
  dist/           Built extension + MCP server
  rules/          English MCP rules (mcp-messenger.mdc)
  HOW_IT_WORKS.md Architecture documentation
.cursor/rules/    Workspace copy of MCP rules (English)
```

## MCP rules

The plugin installs `.cursor/rules/mcp-messenger.mdc` into workspaces. The English version requires the AI to:

- Call `check_messages` after every reply
- Use `ask_question` when user input is required
- Use `send_progress` during multi-step tasks

## Related project

**Remote SSH / VPS** variant lives in a separate repo:

- Local: `C:\Users\jar71\Downloads\jefr-cursor-ssh`
- GitHub: https://github.com/rainfrog123/jefr-cursor-ssh

This repo’s `multi-agent-local` branch is the local-only line. The old `multi-agent-ssh` branch was removed after the split.

## License

See extension `package.json` (MIT).
