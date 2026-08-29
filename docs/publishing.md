# Agent Hooks publishing

`@sigilcore/agent-hooks` publishes from GitHub Actions through an npm trusted
publisher. GitHub supplies a short-lived OIDC identity for each release. No
long-lived npm token, passkey, browser session, or TOTP is part of a routine
release.

The trust boundary has two matching controls:

1. The GitHub `npm-production` environment permits only protected branches.
2. npm trusts `Sigil-Core/agent-hooks`, `.github/workflows/publish.yml`, and the
   `npm-production` environment for direct publication.

The npm relationship must allow direct publish. A stage-only relationship will
reject this workflow and must not be used as a fallback.

## Release contract

A release starts only when GitHub publishes a release. The workflow:

1. Checks out the release tag with full history and no persisted GitHub
   credentials.
2. Requires the tag to equal `v<package.version>`.
3. Peels the tag to a commit, proves that commit is an ancestor of
   `origin/main`, and requires the checked-out `HEAD` to be that commit.
4. Runs the publication guard, type checking, lint, tests, and build.
5. Packs one exact tarball and computes its SHA-1 and SHA-512 integrity.
6. Publishes that tarball once with public access, provenance, and the `latest`
   tag when the version is absent.
7. Verifies the exact tarball digests, repository, SLSA provenance, and
   `latest` binding from npm.

The workflow exposes one publication command. It has `id-token: write` only in
the protected release job and never references `NPM_TOKEN`.
The pinned `setup-node` action does not require `NODE_AUTH_TOKEN`, and package
manager caching is disabled in the privileged release job.

## Safe reruns

An interrupted publish can leave the registry changed even when GitHub reports
failure. A rerun packs the release again before deciding what to do.

- If the version is absent, the workflow publishes once.
- If the exact version, digests, repository, provenance, and `latest` binding
  already exist, the workflow skips publication and verifies the release.
- If an immutable field differs, the workflow fails. It does not overwrite the
  version or accept a different artifact.

Post-publish verification uses a 15-second timeout per registry request and one
180-second deadline. It retries only transient registry responses, delayed
provenance, and delayed `latest` propagation. Authentication, authorization,
validation, and digest mismatches fail immediately.

## Rollback

npm versions are immutable. Rollback means reverting the source, reviewing the
revert, increasing the patch version, and publishing the next patch through the
same release workflow. Routine automation never deletes a version or moves
`latest` backward. An emergency operator may move a dist-tag through npm's
recovery procedure, but that is not the normal release path.

## One-time trust conversion

Moving from the former stage-only relationship to direct OIDC publication is a
one-time npm account operation. Revoke the old relationship, create the direct
publisher for the same repository, workflow, and environment, then verify it
before publishing a GitHub release. npm may require fresh TOTP values for those
trust-management commands. After conversion, normal releases require no user
authentication.
