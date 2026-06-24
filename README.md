# jefr cursor

English-localized Cursor IDE extension for side-panel chat via **Model Context Protocol (MCP)**.

## Quick start

See [QUICKSTART.txt](QUICKSTART.txt).

1. Install `jefr-cursor.vsix` in Cursor Extensions
2. Restart Cursor
3. Enable **jefr cursor** under Settings → Tools & MCP
4. Send `Hello` once in native chat to start the loop
5. Continue from the **jefr cursor** bottom panel

## Location

Canonical checkout: **`C:\Users\jar71\Downloads\jefr-cursor`** (extension + `automation/` CDP scripts in one tree).

## Repository layout

```
extension/
  dist/           Built extension + MCP server
  rules/          English MCP rules (mcp-messenger.mdc)
  HOW_IT_WORKS.md Architecture documentation
obsidian-plugin/  Optional Obsidian chat client
.cursor/rules/    Workspace copy of MCP rules (English)
```

## MCP rules

The plugin installs `.cursor/rules/mcp-messenger.mdc` into workspaces. The English version requires the AI to:

- Call `check_messages` after every reply
- Use `ask_question` when user input is required
- Use `send_progress` during multi-step tasks

## License

See extension `package.json` (MIT).
