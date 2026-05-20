# Triage Reply Templates

These files are the default Onee-sama triage reply templates.

They are intentionally stored as templates, not Go string literals, because
Slack reply style is a workspace contract. Operators can override them by
setting `ONEESAMA_TRIAGE_TEMPLATE_DIR` to a directory containing files with the
same names, or by placing overrides under:

`$ONEESAMA_SLACK_WORKSPACE_DIR/templates/triage/`

Supported template data fields:

- `Classification`
- `ChannelID`
- `ThreadTS`
- `MessageText`
- `Snippet`
- `Title`
- `Subject`
- `Excerpt`
- `URL`
- `OriginalText`
- `Evidence`
- `Language`

Keyword templates ending in `_keywords.en.tmpl` are newline-delimited marker
lists used for routing/classification, not user-visible replies. Blank lines
and `#` comments are ignored. Keep them workspace-specific and conservative:
they decide whether a candidate needs more context or should be treated as
owner-directed operational work.

Markers are trimmed by default. Wrap a marker in double quotes when leading or
trailing spaces are meaningful for a word-boundary match, for example `" pr "`.
