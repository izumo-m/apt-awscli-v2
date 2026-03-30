# Pulumi — Lambda Infrastructure Setup

Deploy Lambda + EventBridge infrastructure via Pulumi that automatically keeps the APT repository up to date.

## Architecture

Running `pulumi up` creates the following AWS resources:

| Resource | Description |
|---------|------|
| S3 Bucket | APT repository hosting (public read) |
| SSM Parameter Store | GPG signing private key (SecureString) |
| Lambda Function | Detects new versions, builds deb packages, updates APT index |
| IAM Roles | Lambda execution role, EventBridge scheduler role |
| EventBridge Scheduler | Periodic Lambda execution (default: Wed–Sun UTC 0:00) |
| CloudWatch Logs | Lambda log retention |

## Prerequisites

- Pulumi CLI (see installation instructions below)
- Node.js 18 or later
- Docker (used for Lambda cross-compilation builds)
- [cargo-make](https://github.com/sagiegurari/cargo-make) (`cargo install cargo-make`)
- AWS credentials (permissions for S3 / SSM / IAM / Lambda / EventBridge operations)

## Required IAM Permissions

Grant the following to the user/role running `pulumi up`.

**AWS Managed Policy**

- `PowerUserAccess`

**Custom Inline Policy (for IAM role operations)**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:PutRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:DeleteRolePolicy",
        "iam:PassRole"
      ],
      "Resource": "*"
    }
  ]
}
```

> **Note:** GPG key existence checks use only `ssm:DescribeParameters`, so `ssm:GetParameter` / `kms:Decrypt` are not required for the deploying user (they are granted to the Lambda execution role instead).

## Installing Pulumi CLI

```bash
curl -fsSL https://get.pulumi.com | sh
```

Verify installation:

```bash
which pulumi
pulumi version
```

Update:

```bash
curl -fsSL https://get.pulumi.com | sh
```

## Initial Setup

### Install Dependencies and Set Environment Variables

```bash
cd pulumi  # this directory
npm ci
```

Add the following to `pulumi/.env` and load with `direnv` or similar (`.env` is already in `.gitignore`):

```bash
export APT_AWSCLI_V2_BACKEND=s3://your-apt-pulumi-state  # S3 bucket for Pulumi state
export APT_AWSCLI_V2_STACK=dev                            # Stack name
export PULUMI_CONFIG_PASSPHRASE=                          # No secrets in state; passphrase not needed
export PULUMI_PAGER=                                      # Disable pager
```

### Create Configuration File (New Setup Only)

If there is no configuration file in the Pulumi state yet (first-time setup), copy from the sample and edit it.

```bash
cp Pulumi.sample.yaml Pulumi.dev.yaml
$EDITOR Pulumi.dev.yaml
```

### Run bootstrap

```bash
# Creates the S3 bucket, initializes the stack, and syncs the configuration file all at once
npm run bootstrap

# To configure versioning (number of versions to retain):
# npm run bootstrap versioning=5
```

`bootstrap` automatically performs the following:
1. Checks whether the `APT_AWSCLI_V2_BACKEND` S3 bucket exists, and creates it after confirmation if not
2. Initializes the stack with `pulumi stack select` / `pulumi stack init`
3. Syncs `Pulumi.{stack}.yaml` with the Pulumi state (stack tags):

   | Local | Pulumi State | Behavior |
   |---------|---------------|------|
   | Absent | Present | Restores from state |
   | Present | Present | Prompts to overwrite with the state version (local changes will be lost) |
   | Present | Absent | Uses local as-is (new setup) |
   | Absent | Absent | Exits with error (prompts to copy from sample) |

### Deploy

```bash
npm run up
# After success, Pulumi.{stack}.yaml is automatically saved as Pulumi state stack tags
```

### Example Pulumi.dev.yaml Configuration

Define the required configuration in `Pulumi.dev.yaml`. This single file contains all configuration.

```yaml
config:
  aptAwscliV2:resourcePrefix: your-prefix
  aptAwscliV2:email: user@example.com
  aptAwscliV2:maintainerName: Your Name
  aptAwscliV2:s3Uri: s3://your-apt-bucket/apt/
```

Running `pulumi up` automatically executes the following:

1. Generates a GPG key and registers it in SSM Parameter Store (`SecureString`), if not already present
2. Creates an S3 bucket and configures the public read policy
3. Creates IAM roles and policies (for Lambda and the scheduler)
4. Builds the Lambda function (via Docker) and deploys it
5. Configures a schedule (default: Wed–Sun UTC 0:00) using EventBridge Scheduler

## Setup on Another Machine

To use an already-deployed environment on a different machine, `bootstrap` restores the configuration from Pulumi state.
No need to manually copy `Pulumi.{stack}.yaml`.

```bash
cd pulumi
npm ci

# Set up .env with the same values as the existing stack
# (see "Install Dependencies and Set Environment Variables" above)
source .env  # or direnv allow

# Restore Pulumi.dev.yaml from Pulumi state and select the stack
npm run bootstrap

# Start operations immediately
npm run preview
npm run up
```

## Configuration File Synchronization

When you edit `Pulumi.{stack}.yaml`, run `npm run up`; changes are automatically saved as Pulumi state stack tags on success.
To pull the latest configuration on another machine, re-run `npm run bootstrap` (you will be prompted to confirm overwriting).

## Deleting Resources

```bash
npm run destroy
```

Deletes all AWS resources (Lambda, S3, IAM, EventBridge, etc.). After completion, you are prompted whether to also delete the state bucket (`APT_AWSCLI_V2_BACKEND`).

```
Pulumi stack has been destroyed.
Do you also want to delete the state bucket "s3://your-apt-pulumi-state"? [y/N]
```

- `y` → Empties and deletes the state bucket
- `N` → Keeps the state bucket (can be reused with `npm run bootstrap` later)

## Deploying in Environments with Restricted IAM Permissions

If only `PowerUserAccess` is granted and IAM role creation is not permitted, have an administrator deploy the IAM resources separately.

### Administrator (Initial setup / when IAM changes are needed)

```bash
npm run up:iam   # Deploy only aws:iam/* resources
```

### Developer (Normal operations)

```bash
npm run up   # Deploys all resources (skips IAM if unchanged)
```

If there are pending IAM changes, a permission error occurs at the start and execution stops without touching other resources. Ask the administrator to run `npm run up:iam`.

## Client Configuration After Deployment

Given `aptAwscliV2:s3Uri: s3://your-apt-bucket/apt/`, configure the client as follows.
Replace the region in the URL (`ap-northeast-1`) with your `aws:region` value:

```bash
# Import the signing public key
curl -fsSL https://your-apt-bucket.s3.ap-northeast-1.amazonaws.com/apt/public.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/apt-awscli-v2.gpg

# Add APT source
echo "deb [signed-by=/usr/share/keyrings/apt-awscli-v2.gpg] \
  https://your-apt-bucket.s3.ap-northeast-1.amazonaws.com/apt stable main" \
  | sudo tee /etc/apt/sources.list.d/aws-tools.list

# Install
sudo apt update
sudo apt install awscli-v2
sudo apt install session-manager-plugin
```

## Customization

All configuration is managed through config keys in `Pulumi.*.yaml`. Re-run `npm run up` after making changes.

### Selecting Managed Packages

The default includes both AWS CLI v2 and Session Manager Plugin. To manage AWS CLI v2 only:

```yaml
config:
  aptAwscliV2:aptPackages:
    - aws-cli
```

### Multi-architecture (amd64 + arm64)

```yaml
config:
  aptAwscliV2:aptArches:
    - amd64
    - arm64
```

### Changing the Schedule (Daily UTC 0:00)

```yaml
config:
  aptAwscliV2:scheduleCron: "cron(0 0 ? * * *)"
```

**EventBridge cron expression syntax**

Format: `cron(minute hour day month day-of-week year)`

| Field | Value Range | Wildcards |
|-----------|---------|-------------|
| Minute | 0–59 | `, - * /` |
| Hour | 0–23 | `, - * /` |
| Day | 1–31 | `, - * / ? L W` |
| Month | 1–12 or JAN–DEC | `, - * /` |
| Day-of-week | 1–7 or SUN–SAT | `, - * / ? L #` |
| Year | 1970–2199 | `, - * /` |

> **Note:** Either day or day-of-week must always be `?` (unspecified). Specifying values for both will result in an error.

**Main wildcards:**

| Symbol | Meaning | Example |
|------|------|-----|
| `*` | All values | `*` (every hour, every day, etc.) |
| `?` | Unspecified (day and day-of-week only) | `?` in day → specify by day-of-week |
| `-` | Range | `MON-FRI` (Monday through Friday) |
| `,` | List | `WED,THU,FRI` |
| `/` | Interval | `0/6` (every 6 starting from 0) |
| `L` | Last day / last day-of-week | `L` in day (end of month), `6L` in day-of-week (last Friday) |
| `W` | Nearest weekday (day only) | `15W` (nearest weekday to the 15th) |
| `#` | Nth day-of-week (day-of-week only) | `2#1` (first Monday) |

**Configuration examples:**

```yaml
# Daily UTC 0:00 (default is Wed–Sun only)
aptAwscliV2:scheduleCron: "cron(0 0 ? * * *)"

# Weekdays only, UTC 9:00 (Japan Standard Time 18:00)
aptAwscliV2:scheduleCron: "cron(0 9 ? * MON-FRI *)"

# Every Monday UTC 3:00
aptAwscliV2:scheduleCron: "cron(0 3 ? * MON *)"

# Every 6 hours (0:00, 6:00, 12:00, 18:00)
aptAwscliV2:scheduleCron: "cron(0 0/6 ? * * *)"

# 1st and 15th of every month at UTC 0:00
aptAwscliV2:scheduleCron: "cron(0 0 1,15 * ? *)"

# Last day of every month at UTC 0:00
aptAwscliV2:scheduleCron: "cron(0 0 L * ? *)"
```

> All times are **UTC**. Since Japan Standard Time (JST) is UTC+9, to run at JST 9:00, specify UTC 0:00 (`cron(0 0 ...)`).

### Setting Maximum Version Retention

```yaml
config:
  aptAwscliV2:maxVersions: "3"
```

### Failure Notifications (SNS Email)

When `notificationEmail` is set, email notifications are sent when Lambda fails due to a crash, timeout, or unhandled exception.

```yaml
config:
  aptAwscliV2:notificationEmail: alert@example.com
```

Resources created:

- SNS Topic (`{resourcePrefix}-notification`)
- SNS Email Subscription
- CloudWatch MetricAlarm (monitors Lambda `Errors` metric)

**Subscription Confirmation (Important)**

After the first deployment, confirm the subscription **via SDK, not by clicking the email link**.
Confirming via SDK sets `ConfirmationWasAuthenticated=true`, preventing accidental unsubscription via the email link.

```bash
npm run confirm-subscription -- '<URL from confirmation email>'
```

The confirmation email contains a URL in this format:
```
https://sns.<region>.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:...&Token=<token>
```

> **Note:** Do **not** click the "Confirm subscription" link in the email.
> Clicking the link sets `ConfirmationWasAuthenticated=false`, allowing anyone to unsubscribe using the same link format.
> Confirming via SDK requires AWS authentication (console or CLI) to unsubscribe, which is more secure.

You can verify behavior with `npm run invoke '{"fail_for_test": true}'`.

### Disabling the Scheduler (Manual Execution Only)

```yaml
config:
  aptAwscliV2:enableScheduler: "false"
```

### Reusing an Existing Bucket

Specify the bucket name and prefix with `s3Uri`.

```yaml
config:
  aptAwscliV2:s3Uri: s3://my-existing-bucket/apt/
```

### Enabling Access Logs

```yaml
config:
  aptAwscliV2:accessLogsS3Uri: s3://my-logs-bucket/access-logs/
  # aptAwscliV2:accessLogRetentionDays: "90"  # Log retention days (-1 for indefinite, default: -1)
```

If `s3Uri` and `accessLogsS3Uri` share the same bucket, **use different prefixes** so that APT files and logs do not intermingle.

```yaml
config:
  aptAwscliV2:s3Uri: s3://my-bucket/apt/
  aptAwscliV2:accessLogsS3Uri: s3://my-bucket/logs/
```

> **Note:** A shared bucket has public access enabled (for the APT repository). If logs must be completely private, use a separate bucket.

## Post-Deployment Verification (Smoke Test)

```bash
# Verify the GPG key was registered in SSM
aws ssm get-parameter --name /your-prefix/private.key --with-decryption

# Invoke Lambda manually
npm run invoke '{}'

# Skip deb build; only regenerate index, sign, and sync to S3
# (useful after updating the signing key or when InRelease needs regeneration)
npm run invoke '{"deploy_only": true}'

# Intentionally raise an exception (for verifying notification behavior)
npm run invoke '{"fail_for_test": true}'

# Check CloudWatch Logs
npm run logs
npm run logs -- --follow           # Follow (equivalent to tail -f)
npm run logs -- --since 60         # Logs from the past 60 minutes
```

## Pulumi Config Key Reference

| Key | Required | Default | Description |
|------|:----:|-----------|------|
| `aptAwscliV2:resourcePrefix` | ✅ | — | Common prefix for all resource names |
| `aptAwscliV2:email` | ✅ | — | Maintainer email address |
| `aptAwscliV2:maintainerName` | ✅ | — | Maintainer name |
| `aptAwscliV2:s3Uri` | ✅ | — | S3 URI for the APT repository (e.g., `s3://my-bucket/apt/`) |
| `aws:region` | | SDK default | AWS region (auto-detected from environment variables such as `AWS_REGION` or `~/.aws/config`) |
| `aptAwscliV2:accessLogsS3Uri` | | Disabled | S3 URI for access log delivery (e.g., `s3://my-logs/`). Enables logging when set |
| `aptAwscliV2:accessLogRetentionDays` | | `-1` | Access log retention days (`-1` for indefinite) |
| `aptAwscliV2:ssmParamName` | | `/<resourcePrefix>/private.key` | SSM parameter name for the GPG private key |
| `aptAwscliV2:maxVersions` | | `-1` | Maximum number of pool versions (`-1` for unlimited) |
| `aptAwscliV2:aptArches` | | `[amd64]` | List of APT build target architectures (`amd64` / `arm64`) |
| `aptAwscliV2:aptPackages` | | `[aws-cli, session-manager-plugin]` | List of managed packages (`aws-cli` / `session-manager-plugin`) |
| `aptAwscliV2:lambdaArch` | | `arm64` | Lambda architecture (`x86_64` / `arm64`) |
| `aptAwscliV2:lambdaMemorySize` | | `5120` | Lambda memory size (MB) |
| `aptAwscliV2:lambdaEphemeralStorage` | | `512` | Lambda ephemeral storage (MB, 512–10240). Free up to 512MB |
| `aptAwscliV2:lambdaTimeout` | | `900` | Lambda timeout (seconds) |
| `aptAwscliV2:lambdaThreads` | | `8` | S3 sync / parallel processing thread count |
| `aptAwscliV2:lambdaZstdThreads` | | `4` | zstd compression thread count |
| `aptAwscliV2:lambdaZstdLevel` | | `9` | zstd compression level (1–22) |
| `aptAwscliV2:scheduleCron` | | `cron(0 0 ? * WED,THU,FRI,SAT,SUN *)` | EventBridge schedule expression |
| `aptAwscliV2:logRetentionDays` | | `14` | CloudWatch Logs retention days |
| `aptAwscliV2:enableScheduler` | | `true` | Set to `false` to skip EventBridge Scheduler creation |
| `aptAwscliV2:notificationEmail` | | Disabled | Email for Lambda failure notifications. Creates SNS + CloudWatch Alarm when set |

## Resource Name Derivation Rules

With `resourcePrefix = "your-prefix"` and `s3Uri = "s3://your-apt-bucket/apt/"`:

| Resource | Name |
|---------|------|
| S3 Bucket | `your-apt-bucket` (bucket portion of `s3Uri`) |
| SSM Parameter | `/your-prefix/private.key` |
| Lambda Function | `your-prefix-lambda` |
| IAM Role (for Lambda) | `your-prefix-lambda-role` |
| IAM Role (for Scheduler) | `your-prefix-scheduler-role` |
| EventBridge Schedule | `your-prefix-schedule` |
| CloudWatch Log Group | `/aws/lambda/your-prefix-lambda` |

## Versioning

This project uses [Semantic Versioning](https://semver.org/) with a single version for the entire project.

- **Source of truth**: `pulumi/package.json` (`"version"` field)
- **Git tag format**: `vX.Y.Z` (created after successful deploy)
- `lambda/Cargo.toml` version is set to `0.0.0` (not managed independently)

### Release Workflow

1. **Bump version** (in the `develop` branch):

   ```bash
   cd pulumi
   npm version patch   # or minor / major
   ```

   This updates `package.json` and `package-lock.json` without creating a git tag (configured via `.npmrc`).

2. **Commit, push, and merge** to `main` via pull request.

3. **Deploy**:

   ```bash
   npm run up
   ```

4. **Tag the release** (after successful deploy):

   ```bash
   git tag vX.Y.Z
   git push --tags
   ```

## Redeploying After Lambda Source Updates

After editing `../lambda/src/` or similar files, simply run `pulumi up` from this directory.
It automatically detects source file changes by hash and runs `cargo make build` to update the Lambda code.

```bash
cd pulumi  # this directory
npm run up
```

## Previewing Changes (preview)

Review which resources will be changed before running `pulumi up`.

```bash
cd pulumi  # this directory
npm run preview
```

`pulumi preview` makes no changes to AWS and displays the following:

- `+ create` — new resources to be created
- `~ update` — resources to be modified (with before/after diff)
- `- delete` — resources to be deleted
- `+-replace` — resources to be deleted and recreated (requires attention)

On the first deployment, all resources appear as `+ create`.

### Viewing Currently Deployed Resources

```bash
pulumi stack
```

### Viewing Details of Individual Resources

```bash
pulumi stack export   # Outputs the entire state as JSON
```
