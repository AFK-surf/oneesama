# Triage Reply Templates

These files are the default Onee-sama triage reply templates.

They are intentionally stored as templates, not Go string literals, because
Slack reply style is a workspace contract. Operators can override them by
setting `ONEESAMA_TRIAGE_TEMPLATE_DIR` to a directory containing files with the
same names, or by placing overrides under:

`$ONEESAMA_SLACK_WORKSPACE_DIR/templates/triage/`

Supported template data fields:

- `Classification`
- `MessageText`
- `Snippet`
- `Title`
- `Subject`
- `Excerpt`
- `URL`
- `OriginalText`
- `Evidence`
- `Language`
