---
title: "Git dependencies install the package without a built dist"
category: packaging
module: packaging
date: "2026-11-21"
problem_type: packaging
component: package
severity: high
symptoms:
  - "A git dependency resolved the package entry points to missing dist files"
  - "Importing the package failed with a module-not-found error"
  - "The CLI bin failed because its dist entry point did not exist"
root_cause: build_lifecycle
resolution_type: config_change
related_components:
  - installation
tags:
  - packaging
  - git-dependency
  - pnpm
  - prepare
  - build
---

# Git dependencies install the package without a built dist

## Problem

The package publishes its entry points, CLI bin, and types from a build output directory. A consumer that installed a repository commit through a pnpm git dependency received the source package with no build output, so importing the package and running the CLI both failed. The npm registry tarball was unaffected because publishing builds first.

## Symptoms

- The dependency resolves, but importing an exported symbol fails because the built module is absent.
- The CLI bin points at a missing built file.
- The package manager reports that the git-hosted package needs to run build scripts but is not allowlisted.

## What Didn't Work

- Adding a registry-only publish hook: it runs for registry publication and never for a git checkout.
- Committing the build output: it is generated, platform-independent output that would drift from the source and bloat history.

## Solution

Run the build from the package's prepare lifecycle, which package managers execute after installing a git dependency:

```json
{
  "scripts": {
    "prepare": "pnpm run build"
  }
}
```

pnpm 10 and newer block dependency build scripts by default. The consumer allows this package's prepare build in its workspace configuration, using the resolution key pnpm prints in its `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` error, or runs `pnpm approve-builds` and selects the package. The documented install command then resolves the package by its repository commit plus the package subdirectory.

## Why This Works

A git dependency installs the package's development dependencies, then runs prepare. Prepare invokes the same build used at publish time, producing the ESM entry, CJS entry, declarations, and CLI. The consumer's allowlist is the package manager's explicit trust decision for that build; without it the package manager correctly refuses to execute the script. Once the build completes, both the import entry and the bin resolve to real files.

## Prevention

- Verify a git install, not only a packed registry tarball, in a scratch project outside the repository. Run both an import of an exported symbol and the CLI bin.
- Treat a new build output path as requiring both a publish build and a git-install prepare build.
- When a package manager blocks dependency scripts, document the allowlist or approval step next to the install command rather than assuming scripts run.
