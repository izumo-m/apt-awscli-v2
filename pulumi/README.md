# Pulumi — Lambda Infrastructure Setup

Deploy Lambda + EventBridge infrastructure via Pulumi that automatically keeps the APT repository up to date.

## Architecture

Running `pulumi up` creates the following AWS resources:

| Resource | Description |
|---------|------|
| S3 Bucket | APT repository hosting (public read) |
| S3 BucketObject | `index.html` generated from `README.md` (updated on each deploy) |
| SSM Parameter Store | GPG signing private key (SecureString) |
| Lambda Function | Detects new versions, builds deb packages, updates APT index |
| IAM Roles | Lambda execution role, EventBridge scheduler role |
| EventBridge Scheduler | Periodic Lambda execution (default: Wed–Sun UTC 0:00) |
| CloudWatch Logs | Lambda log retention |
| SNS Topic + CloudWatch Alarm | Lambda failure email notifications (optional) |

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

### Install Dependencies

```bash
cd pulumi  # this directory
npm ci
```

### Create the S3 Backend Bucket

```bash
npm run bootstrap -- --backend s3://your-apt-pulumi-state

# To configure versioning (number of versions to retain):
# npm run bootstrap -- --backend s3://your-apt-pulumi-state --versioning 5
```

### Log In and Initialize the Stack

```bash
pulumi login s3://your-apt-pulumi-state
pulumi stack init dev
```

### Create Configuration File

Copy from the sample and edit:

```bash
cp Pulumi.sample.yaml Pulumi.dev.yaml
$EDITOR Pulumi.dev.yaml
```

Optionally, add the following to `pulumi/.env` and load with `direnv` or similar (`.env` is already in `.gitignore`):

```bash
export PULUMI_BACKEND_URL=s3://your-apt-pulumi-state  # Can replace `pulumi login`
export PULUMI_CONFIG_PASSPHRASE=                      # No secrets in state; passphrase not needed
export PULUMI_PAGER=                                  # Disable pager
```

### Deploy

```bash
pulumi up
```

Running `pulumi up` automatically executes the following:

1. Generates a GPG key and registers it in SSM Parameter Store (`SecureString`), if not already present
2. Creates an S3 bucket and configures the public read policy
3. Creates IAM roles and policies (for Lambda and the scheduler)
4. Builds the Lambda function (via Docker) and deploys it, capturing a source snapshot for later `preview --diff`
5. Backs up `Pulumi.{stack}.yaml` to the state bucket as a managed `aws.s3.BucketObjectv2`
6. Configures a schedule (default: Wed–Sun UTC 0:00) using EventBridge Scheduler

### Example Pulumi.dev.yaml Configuration

Define the required configuration in `Pulumi.dev.yaml`. This single file contains all configuration.

```yaml
config:
  aptAwscliV2:email: user@example.com
  aptAwscliV2:maintainerName: Your Name
  aptAwscliV2:s3Uri: s3://your-apt-bucket/apt/
```

## Setup on Another Machine

To use an already-deployed environment on a different machine:

```bash
cd pulumi
npm ci

pulumi login s3://your-apt-pulumi-state
pulumi stack select dev

# Restore Pulumi.dev.yaml from Pulumi state
npm run restore-config dev

# Start operations
pulumi preview
pulumi up
```

## Configuration File Synchronization

`Pulumi.{stack}.yaml` is backed up to the Pulumi state bucket as a managed asset
(`aws.s3.BucketObjectv2` at `s3://<state-bucket>/stack-configs/Pulumi.{stack}.yaml`).
Edits to the file appear as a normal diff in `pulumi preview` and are uploaded
during `pulumi up` as part of the stack itself — no post-hook involved.

To pull the latest configuration on another machine, run
`npm run restore-config <stack>` (you will be prompted to confirm overwriting).
If the state bucket has versioning enabled (see `--versioning` on
`npm run bootstrap`), historical versions of the file can be inspected with
`aws s3api list-object-versions` / `get-object --version-id`.

## Deleting Resources

```bash
npm run destroy
```

Deletes all AWS resources (Lambda, S3, IAM, EventBridge, etc.). If `PULUMI_BACKEND_URL` is set to an S3 URL, you are prompted whether to also delete the state bucket.

```
Pulumi stack has been destroyed.
Do you also want to delete the state bucket "s3://your-apt-pulumi-state"? [y/N]
```

- `y` → Empties and deletes the state bucket
- `N` → Keeps the state bucket (can be reused later)

## Deploying in Environments with Restricted IAM Permissions

If only `PowerUserAccess` is granted and IAM role creation is not permitted, have an administrator deploy the IAM resources separately.

### Administrator (Initial setup / when IAM changes are needed)

```bash
npm run up:iam   # Deploy only aws:iam/* resources
```

### Developer (Normal operations)

```bash
pulumi up    # Deploys all resources (skips IAM if unchanged)
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

All configuration is managed through config keys in `Pulumi.*.yaml`. Re-run `pulumi up` after making changes.

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

### Changing the Schedule

Default: `cron(0 0 ? * TUE-SAT *)` — runs at JST 9:00 on Tue–Sat, to pick up AWS releases from the previous US business day.

To change to daily at UTC 0:00:

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
# Every day at UTC 0:00 (default runs Tue–Sat only)
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

When `notificationEmail` is set, email notifications are sent when the Lambda function fails.

```yaml
config:
  aptAwscliV2:notificationEmail: alert@example.com
```

**Resources created:**

| Resource | Name | Description |
|----------|------|-------------|
| SNS Topic | `{resourcePrefix}-notification` | Notification channel |
| SNS Subscription | (email) | Email subscription to the topic |
| CloudWatch MetricAlarm | `{resourcePrefix}-lambda-errors` | Triggers on Lambda errors |

**Alarm conditions:**

The CloudWatch Alarm monitors the `AWS/Lambda` → `Errors` metric for the Lambda function. It triggers when the sum of errors in a **60-second period** is **≥ 1**. Missing data is treated as "not breaching" (no false alarms when the function is not invoked). This covers crashes, timeouts, and unhandled exceptions.

**Subscription confirmation (Important)**

After the first deployment, a confirmation email is sent to the configured address. Confirm the subscription **via SDK, not by clicking the email link**:

```bash
npm run confirm-subscription -- '<URL from confirmation email>'
```

The confirmation email contains a URL in this format:
```
https://sns.<region>.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:...&Token=<token>
```

> **Note:** Do **not** click the "Confirm subscription" link in the email.
> Clicking the link sets `ConfirmationWasAuthenticated=false`, allowing anyone to unsubscribe using the same link format.
> Confirming via SDK sets `ConfirmationWasAuthenticated=true`, requiring AWS authentication (console or CLI) to unsubscribe, which is more secure.

**Verifying notifications:**

```bash
npm run invoke '{"fail_for_test": true}'
```

This intentionally raises an exception in the Lambda function. If everything is configured correctly, you should receive an alarm email within a few minutes.

**Changing the email address:**

Update `notificationEmail` in `Pulumi.{stack}.yaml` and run `pulumi up`. A new confirmation email is sent; repeat the SDK confirmation step above.

**Disabling notifications:**

Remove the `notificationEmail` key from `Pulumi.{stack}.yaml` and run `pulumi up`. The SNS Topic, Subscription, and CloudWatch Alarm are deleted.

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

## Generating index.html

The repository root URL serves an `index.html` generated from the top-level `README.md`.
This file is automatically generated during `pulumi preview` and `pulumi up`, and deployed to S3 as a `BucketObjectv2` resource.

To generate it independently (e.g., for local preview):

```bash
npm run generate-index-html
# Output: pulumi.out/index.html
```

## npm Scripts Reference

| Script | Description |
|--------|-------------|
| `npm run bootstrap` | Create and configure the S3 backend bucket |
| `npm run restore-config <stack>` | Restore `Pulumi.{stack}.yaml` from the Pulumi state bucket |
| `npm run diff` | Show a unified diff of Lambda sources vs. the deployed version |
| `npm run up:iam` | Deploy only IAM resources (for restricted-permission environments) |
| `npm run destroy` | Run `pulumi destroy` with optional state bucket cleanup |
| `npm run invoke` | Invoke the Lambda function |
| `npm run logs` | View CloudWatch Logs (`--follow` / `--since N`) |
| `npm run confirm-subscription` | Confirm SNS subscription via SDK |
| `npm run generate-index-html` | Generate `pulumi.out/index.html` from README.md |

## Pulumi Config Key Reference

| Key | Required | Default | Description |
|------|:----:|-----------|------|
| `aptAwscliV2:resourcePrefix` | | `apt-awscli-v2` | Common prefix for all resource names |
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
| `aptAwscliV2:scheduleCron` | | `cron(0 0 ? * TUE-SAT *)` | EventBridge schedule expression |
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
   pulumi up
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
pulumi up
```

## Previewing Changes (preview)

Review which resources will be changed before running `pulumi up`.

```bash
cd pulumi  # this directory
pulumi preview
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
