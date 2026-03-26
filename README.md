# apt-awscli-v2

APT repository for AWS CLI v2 and Session Manager Plugin.
When a new version is released to the official AWS distribution, APT packages are automatically generated and published.
(Actual publication is delayed by approximately 1 day)

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
