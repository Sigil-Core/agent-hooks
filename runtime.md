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
