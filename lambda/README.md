# apt-awscli-v2 Lambda (Rust)

Rust-based AWS Lambda that automatically builds and deploys new versions of AWS CLI v2 and the Session Manager Plugin.
Scheduled via EventBridge to detect and deploy new versions on a regular basis.

## Processing Flow

```
EventBridge (scheduled execution)
  → Lambda invocation
    1. Load configuration from environment variables (target packages specified via APT_AWSCLI_V2_PACKAGES)
    2. Sync S3 → local (/tmp/repo)                          ┐ Parallel execution
    3. Fetch latest version of each package from GitHub     ┘
    4. For each package × architecture, build if the corresponding .deb is missing under pool/main/{pkg}/
    5. Deploy (prune old versions, regenerate index, sign, sync to S3)
       - Load Signer, generate public.key: once
       - Generate Packages/Release/InRelease per package
       - S3 sync: once
```

## S3 Repository Structure

```
s3://apt-awscli-v2-dev/apt/
├── public.key
├── dists/
│   └── stable/
│       ├── Release
│       ├── InRelease
│       └── main/
│           ├── binary-amd64/
│           │   ├── Packages
│           │   └── Packages.gz
│           └── binary-arm64/
│               ├── Packages
│               └── Packages.gz
└── pool/
    └── main/
        ├── awscli-v2/
        │   ├── awscli-v2_2.34.1-1_amd64.deb
        │   ├── awscli-v2_2.34.1-1_arm64.deb
        │   └── ...
        └── session-manager-plugin/
            ├── session-manager-plugin_1.2.779.0_amd64.deb
            └── ...
```

## Source Code Structure

| File | Description |
|----------|------|
| `src/main.rs` | Lambda handler + orchestration |
| `src/lib.rs` | Library root (module re-exports) |
| `src/config.rs` | Configuration loading from environment variables, `Package` enum |
| `src/logging.rs` | Lambda log formatter (tracing-subscriber) |
| `src/s3_sync.rs` | S3 ↔ local sync |
| `src/version.rs` | Latest version fetching (AWS CLI v2 / Session Manager Plugin) |
| `src/builder.rs` | AWS CLI v2 deb build (creates package from official zip) |
| `src/smp_builder.rs` | Session Manager Plugin deb download (fetches official deb directly) |
| `src/deb.rs` | deb package creation (ar + tar + zstd) |
| `src/deploy.rs` | Deploy (prune + index + sign + sync) |
| `src/apt_index.rs` | Packages/Release generation (control.tar.zst / .gz support) |
| `src/sign.rs` | GPG clearsign |

## Metadata Templates (`metadata/`)

Files under `metadata/` are embedded into the Lambda binary at compile time via `include_str!`.
Modifying them changes the source hash, triggering an automatic rebuild and redeploy on `npm run up`.

| File | Embedded in | Description |
|----------|-----------|------|
| `metadata/DEBIAN/control` | `src/builder.rs` | deb package control file template. Replaces `${VERSION}`, `${ARCH}`, etc. at runtime |
| `metadata/DEBIAN/postinst` | `src/builder.rs` | Post-install script (warns about PATH priority if the zip-based `/usr/local/bin/aws` exists) |
| `metadata/Release` | `src/apt_index.rs` | APT `Release` / `InRelease` file template |

## index.html Generation

The top-level `README.md` is converted to HTML at compile time in `build.rs` using [pulldown-cmark](https://github.com/pulldown/pulldown-cmark)
and deployed to S3 as `index.html`, so the repository root URL displays the README content in a browser.

The generated file is also copied to `target/index.html` for local preview:

```bash
cargo check
open target/index.html
```

## Prerequisites

- Docker
- [cargo-make](https://github.com/sagiegurari/cargo-make) (`cargo install cargo-make`)

No Rust or cross-compiler installation is required on the host (builds run inside a Docker container).

## Tests (UT)

Unit tests are in `config.rs`, `version.rs`, `deploy.rs`, `apt_index.rs`, and `smp_builder.rs`.

```bash
# Run all tests
cargo test

# Run tests for a specific module only
cargo test --lib version
cargo test --lib config
cargo test --lib deploy
cargo test --lib apt_index
cargo test --lib smp_builder
```

No Docker or cross-compilation environment required; tests run with the host Rust toolchain.

## Build

### Docker Build (Default)

Cross-compiles with musl static linking inside a Docker container based on
[`rust-musl-cross`](https://github.com/rust-cross/rust-musl-cross).
The resulting binary is fully statically linked (no glibc dependency), ensuring Lambda runtime compatibility.

```bash
# arm64 build (default)
cargo make build

# x86_64 build
APT_AWSCLI_V2_LAMBDA_ARCH=x86_64 cargo make build
```

The first run takes time to build the Docker image; subsequent runs use the cache.
The cargo registry is cached under `target/cargo-registry/`.
`cargo make clean` removes all caches and build artifacts.

### Local Build (Without Docker)

Available when the host has the Rust toolchain and the musl target installed.

```bash
cargo make build-local
APT_AWSCLI_V2_LAMBDA_ARCH=x86_64 cargo make build-local
```

### Artifacts

`CARGO_TARGET_DIR` is separated per architecture, so building both arm64 and x86_64
does not overwrite intermediate artifacts.

| Task | `CARGO_TARGET_DIR` | Final Artifact |
|--------|---------------------|------------|
| `cargo make build` (arm64) | `target/arm64/` | `target/arm64/dist/` |
| `APT_AWSCLI_V2_LAMBDA_ARCH=x86_64 cargo make build` | `target/x86_64/` | `target/x86_64/dist/` |
| `cargo make build-local` | `target/local/` | `target/local/dist/` |

`.cargo/config.toml` sets the default `target-dir` to `target/local`,
so local commands (`cargo test`, `cargo build`) output under `target/local/`.
Docker builds override this via the `CARGO_TARGET_DIR` environment variable, keeping architectures separated.

Each directory contains the following files:

| File | Description |
|----------|------|
| `bootstrap` | Binary for Lambda custom runtime (musl static link) |
| `bootstrap.zip` | ZIP-compressed `bootstrap` (used by `npm run up`) |

## Updating Dependencies

Steps for updating dependency crates in `Cargo.toml` to their latest versions.

### 1. Check for updatable crates

```bash
cargo outdated
```

If [cargo-outdated](https://github.com/kbknapp/cargo-outdated) is not installed, run `cargo install cargo-outdated`.

### 2. Update Cargo.toml

```bash
cargo update
```

Updates `Cargo.lock` within the version ranges in `Cargo.toml` (e.g., `"1"` → latest `1.x.y`).

To bump a major version, edit `Cargo.toml` manually.

### 3. Verify build and tests

```bash
# Confirm tests pass
cargo test

# Confirm Docker build succeeds
cargo make build
```

### 4. Deploy

After tests pass, deploy from `pulumi/`.
The `Cargo.lock` change alters the source hash, so `npm run up` automatically triggers a rebuild and redeploy.

```bash
cd ../pulumi
npm run up
```

## Local Execution

Run the Lambda locally using the `cargo lambda` emulator.
AWS credentials are required as it accesses a real S3 bucket and SSM parameters.

```bash
# 1. Start the Lambda emulator
cargo lambda watch

# 2. Invoke from another terminal
cargo lambda invoke --data-ascii '{}'
```

## Deploy

For initial setup, refer to [pulumi/README.md](../pulumi/README.md).

Deployment is performed via npm scripts in `pulumi/`.
Source file changes are automatically detected by hash, triggering a Docker build and Lambda code update.

### Code Update

```bash
cd ../pulumi

# Build & deploy (arm64)
npm run up

# For x86_64
APT_AWSCLI_V2_LAMBDA_ARCH=x86_64 npm run up
```

### Manual Invocation

```bash
cd ../pulumi
npm run invoke '{}'
```

### Deploy Only (deploy_only)

Skips deb package building and runs only index regeneration, signing, and S3 sync.
Useful after updating the signing key or when InRelease needs to be regenerated.

```bash
cd ../pulumi
npm run invoke '{"deploy_only": true}'
```

### CloudWatch Logs

```bash
cd ../pulumi
npm run logs                       # Logs from the last 10 minutes
npm run logs -- --follow           # Follow (equivalent to tail -f)
npm run logs -- --since 60         # Logs from the past 60 minutes
```
