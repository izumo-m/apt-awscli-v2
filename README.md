# APT repository for AWS CLI v2 (Unofficial)

APT repository for AWS CLI v2 and Session Manager Plugin.
When a new version is released to the official AWS distribution, APT packages are automatically generated and published.

**Supported architectures:** amd64, arm64

## Usage

### Setup (first time only)

```bash
curl -fsSL https://apt-awscli-v2.masanao.site/public.key \
  | sudo gpg --dearmor -o /usr/share/keyrings/apt-awscli-v2.gpg

echo "deb [signed-by=/usr/share/keyrings/apt-awscli-v2.gpg] \
  https://apt-awscli-v2.masanao.site stable main" \
  | sudo tee /etc/apt/sources.list.d/apt-awscli-v2.list
```

### Installation

```bash
sudo apt update
sudo apt install awscli-v2
sudo apt install session-manager-plugin
```

The `awscli-v2` package extracts AWS CLI v2 under `/opt/awscli-v2/` and exposes
its launchers via relative symlinks at `/opt/awscli-v2/bin/{aws,aws_completer}`.
A convenience symlink at `/usr/bin/aws` is created **only if that path is free**
(see the coexistence section below). The `/opt/awscli-v2/bin/aws` path always
works regardless of what else is on the system.

### Coexistence with other `aws` installations

`awscli-v2` is designed to avoid overwriting any existing `aws` command.

| Existing `/usr/bin/aws` | On install |
|---|---|
| not present | symlinked to `/opt/awscli-v2/bin/aws` (this package wins) |
| owned by Ubuntu's `awscli` package (Ubuntu 26.04+) | left intact; a notice points to `/opt/awscli-v2/bin/aws` |
| owned by another `.deb` | left intact; a notice names the owning package |
| placed manually (not owned by any package) | left intact; a notice points to `/opt/awscli-v2/bin/aws` |

In every "left intact" case, `awscli-v2` is still reachable at
`/opt/awscli-v2/bin/aws`. To make it the default `aws` command without removing
the other one, prepend its directory to `PATH`:

```bash
export PATH=/opt/awscli-v2/bin:$PATH
```

To switch back, drop that prefix from `PATH`.

To replace the other `aws` entirely:

```bash
# If Ubuntu's awscli package is installed:
sudo apt remove awscli && sudo apt install --reinstall awscli-v2

# If installed via the official zip installer:
sudo rm /usr/local/bin/aws /usr/local/bin/aws_completer
# /usr/local/bin precedes /usr/bin in PATH, so this is enough to surface
# /usr/bin/aws (which this package's symlink points to /opt/awscli-v2/bin/aws).
```

### Update

```bash
sudo apt update
sudo apt install awscli-v2
```

### Uninstallation

```bash
sudo apt remove awscli-v2
sudo apt remove session-manager-plugin
```

To also remove the repository configuration:

```bash
sudo rm /etc/apt/sources.list.d/apt-awscli-v2.list
sudo rm /usr/share/keyrings/apt-awscli-v2.gpg
```

---

Source: https://github.com/izumo-m/apt-awscli-v2
