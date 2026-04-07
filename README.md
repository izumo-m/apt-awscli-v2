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

The `awscli-v2` package installs `aws` and `aws_completer` to `/usr/bin/`.

> **Note:** If you previously installed AWS CLI v2 via the [official zip installer](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html),
> `/usr/local/bin/aws` may take precedence over `/usr/bin/aws` due to PATH priority.
> Remove the old installation first:
> ```bash
> sudo rm /usr/local/bin/aws /usr/local/bin/aws_completer
> ```

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
