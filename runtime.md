# @sigilcore/agent-hooks Runtime Notes

## npm publish path

`@sigilcore/agent-hooks` publishes from GitHub Actions workflow
`.github/workflows/publish.yml` using npm trusted publishing through OIDC.
The workflow must keep these properties aligned:

- GitHub repository: `Sigil-Core/agent-hooks`
- Workflow filename in npm trusted publisher settings: `publish.yml`
- Runner: GitHub-hosted `ubuntu-latest`
- GitHub permissions: `id-token: write` and `contents: read`
- Node: `22.14.0` or newer
- npm CLI: `11.5.1` or newer
- `package.json` repository URL:
  `git+https://github.com/Sigil-Core/agent-hooks.git`

The workflow does not need an `NPM_TOKEN` repository secret when trusted
publishing is configured. `gh secret list --repo Sigil-Core/agent-hooks`
returned no repository secrets on June 22, 2026.

## Known failure mode

If `npm publish --access public` fails with `E404 Not Found` for an existing
scoped package, do not assume the package is missing. For trusted publishing,
check the npm package trusted publisher configuration and the `repository.url`
field in `package.json`. npm requires the package metadata to match the GitHub
repository that is authorized as the trusted publisher. If `npm trust list`
returns `E401`, the local npm auth can read package metadata but cannot manage
trusted-publisher settings.

Verification baseline before rerunning publish:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm view @sigilcore/agent-hooks version dist-tags name repository --json
```

## CodeRabbit local review support note

On June 23, 2026, CodeRabbit Support confirmed that a Sigil local committed
review that looked stalled completed successfully in about 2 minutes 30 seconds
with 0 findings. The review spent most of its time in `analyzing/summarizing`
while backend summarization, MCP context gathering, and Review Stack artifact
generation ran. Support also saw one transient repository clone failure that
retried successfully and a non-fatal Mermaid sanitizer warning.

If a local review appears hung, let it run for 5 to 10 minutes before stopping
it. If it still does not return, capture:

```bash
DEBUG=* coderabbit review --agent --type committed --base-commit <base_commit>
coderabbit --version
git rev-parse HEAD
```

For an uncommitted review, keep the same `DEBUG=*` prefix and use the actual
review command being debugged. Include the exact start and stop time with
timezone and the full terminal output when opening or updating the support
ticket. This lets CodeRabbit correlate the local process with the backend
review attempt.
