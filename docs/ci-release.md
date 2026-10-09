# CI release: signed, notarized Obfuscate builds from a tag

How a `v<version>` tag becomes a GitHub release carrying a Developer ID signed,
notarized, universal `Obfuscate.app`. Same shape, scripts and secret names as
the nullgate and seed-sync repos, so one set of signing material serves all
three.

## What ships

| Asset | Notes |
|---|---|
| `Obfuscate-<ver>-macos-universal.zip` | `Obfuscate.app` zipped with `ditto`; arm64 + x86_64; Developer ID signed with hardened runtime and secure timestamp; notarized; ticket stapled to the `.app` so Gatekeeper accepts it offline |

The release is created in **one call with the asset attached**, never as a
draft. A `v<ver>-test<N>` tag publishes a **prerelease**. The `publish` job
refuses unless the tag and `CFBundleShortVersionString` in
`apps/macos/Info.plist` agree.

## Shape

`.github/workflows/release.yml` (tag push, or `workflow_dispatch`):

```
gate     ubuntu-24.04   node --test for core, web (no-network), cli — what ci.yml runs
macos    macos-15       swift test; scripts/ci/macos-keychain.sh (Developer ID into a throwaway
                        keychain); apps/macos/build-app.sh with OBFUSCATE_UNIVERSAL=1,
                        CODESIGN_IDENTITY and OBFUSCATE_NOTARIZE=1 (signs, notarizes via
                        scripts/notarize-macos.sh, staples, zips); checks: lipo has x86_64,
                        core byte-identical, codesign --verify --deep --strict, the JIT
                        entitlement and no network entitlement, stapler validate, spctl
publish  ubuntu-24.04   version gate, the one asset, notes from CHANGELOG.md,
                        gh release create --verify-tag (prerelease for -testN)
```

Dispatch inputs: `tag` (an existing tag to build and publish; empty = build the
current ref and publish nothing), `publish`, `sign`. A dispatched run takes the
*workflow* from the branch it was dispatched on and the *source* from the tag,
which is the recovery path for a CI bug.

`ci.yml` is unchanged in spirit: every push still builds the app ad-hoc signed
on `macos-latest` (now universal) and checks the entitlements; only
`release.yml` touches the certificate.

## Signing

**Developer ID + notarization.** `scripts/ci/macos-keychain.sh` imports the
`.p12` from secrets into a throwaway keychain under `$RUNNER_TEMP` and exports
`CODESIGN_IDENTITY`; `apps/macos/build-app.sh` then seals the bundle with
`--timestamp --options runtime` and the entitlements file, verifies it, and
(with `OBFUSCATE_NOTARIZE=1`) runs `scripts/notarize-macos.sh`, which submits a
zip to the notary service, prints the notary log on rejection, and staples the
ticket to the `.app` **before** it is zipped for release.

The certificate is a *second* Developer ID Application certificate under the
same team as the maintainer's own (which is Xcode's cloud-managed kind and
cannot be exported), exactly as nullgate and seed-sync use.

**Entitlements under the hardened runtime.** Exactly one:
`com.apple.security.cs.allow-jit`, because JavaScriptCore's JIT needs it under
the hardened runtime and otherwise falls back to its interpreter, which makes
large logs far slower. It grants executable memory for the JIT and nothing
else. The app is not sandboxed (the in-app updater replaces the bundle in
Applications, which a sandboxed process cannot do in a way that launches) and
holds no network entitlement; `NoNetworkTests` and the CI checks assert that
exact set and the absence of anything network-shaped.

## Secrets and setup (one-time)

Repository secrets on `steeb-k/pii-cleaner`, the **same names and values as
on nullgate and seed-sync**:

| Secret | Value |
|--------|-------|
| `MACOS_CODESIGN_IDENTITY` | `Developer ID Application: <Name> (<TEAMID>)` |
| `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD` | base64 of the CI `.p12`, and its password |
| `MACOS_NOTARY_APPLE_ID`, `MACOS_NOTARY_PASSWORD`, `MACOS_NOTARY_TEAM_ID` | app-specific password form (or `MACOS_NOTARY_KEY`, `_KEY_ID`, `_ISSUER_ID` for an API key) |

The signing material lives **outside the repository** in the maintainer's
signing folder (`~/nullgate-signing`, shared with nullgate and seed-sync).
`set-pii-cleaner-secrets.sh --apple-id <Apple ID>` there (re)sets all six from
those files without printing a value; without `--apple-id` it sets the three
certificate secrets and leaves the notary ones for a second run. Or run
`gh secret set <NAME> -R steeb-k/pii-cleaner < file` for each.

The `release` environment is auto-created by the first publish; add yourself
as a required reviewer there if a release should wait for approval.

## Rollout

1. `gh workflow run release.yml -f publish=false -f sign=false`: the gate and
   macOS jobs run, nothing is signed or published. Download the artifact and
   launch it once by hand.
2. Set the secrets; rerun with `-f sign=true -f publish=false`. Check the macOS
   job's `Authority=Developer ID Application` line, `stapler validate` and the
   `spctl` verdict (`accepted`, `source=Notarized Developer ID`).
3. Tag `v<ver>-test1` (matching `CFBundleShortVersionString`): a prerelease with
   the zip appears.
4. Tag `v<ver>`: the real release, marked latest.

The in-app updater (`apps/macos/Sources/Obfuscate/Updater.swift`) reads
GitHub's `releases/latest`, which only ever returns a non-draft, non-prerelease
release, and downloads `Obfuscate-<ver>-macos-universal.zip` from it. So a
`-testN` prerelease is never offered to users, and a real tag is picked up by
every installed copy within an hour of its next launch or popover open.

## Local use

`bash apps/macos/build-app.sh` on a dev box stays ad-hoc signed and single-arch.
To reproduce the CI build locally with your own Developer ID in the login
keychain:

```sh
OBFUSCATE_UNIVERSAL=1 CODESIGN_IDENTITY='Developer ID Application: <Name> (<TEAMID>)' \
  bash apps/macos/build-app.sh
# add OBFUSCATE_NOTARIZE=1 plus NOTARY_APPLE_ID/NOTARY_PASSWORD/NOTARY_TEAM_ID to notarize + staple
```
