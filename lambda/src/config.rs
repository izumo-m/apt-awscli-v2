use std::str::FromStr;

use anyhow::{Context, Result};

/// Working directory for temporary files (Lambda only allows /tmp)
const WORKDIR: &str = "/tmp";

#[derive(Debug, Clone, PartialEq)]
pub enum Package {
    AwsCli,
    SessionManagerPlugin,
}

impl Package {
    pub fn file_prefix(&self) -> &str {
        match self {
            Package::AwsCli => "awscli-v2",
            Package::SessionManagerPlugin => "session-manager-plugin",
        }
    }
}

impl FromStr for Package {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim() {
            "aws-cli" => Ok(Package::AwsCli),
            "session-manager-plugin" => Ok(Package::SessionManagerPlugin),
            other => anyhow::bail!("Unknown package: {}", other),
        }
    }
}

pub struct Config {
    /// S3 bucket name
    pub s3_bucket: String,
    /// S3 key prefix (without leading/trailing slashes)
    pub s3_prefix: Option<String>,
    /// SSM parameter name for GPG private key
    pub ssm_param: String,
    /// Package maintainer email
    pub email: String,
    /// Package maintainer name
    pub name: String,
    /// Maximum number of versions to keep in the pool (per architecture)
    pub max_versions: Option<usize>,
    /// Target architectures (default: ["amd64"])
    pub archs: Vec<String>,
    /// Packages to manage (default: [AwsCli])
    pub packages: Vec<Package>,
    /// S3 sync concurrency (default: 8)
    pub threads: usize,
    /// zstd compression threads (default: 4)
    pub zstd_threads: u32,
    /// zstd compression level (default: 9)
    pub zstd_level: i32,
    /// SSM parameter name holding the Cloudflare API token JSON.
    /// When `None`, Cloudflare cache invalidation is skipped entirely.
    pub cf_ssm_param: Option<String>,
    /// Cloudflare zone ID (non-secret). Required when `cf_ssm_param` is set.
    pub cf_zone_id: Option<String>,
    /// Public base URL fronting the APT repository (non-secret).
    /// Required when `cf_ssm_param` is set; used to build purge URLs.
    pub cf_public_base_url: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let s3_url = require_env("APT_AWSCLI_V2_S3_URL")?;

        let (s3_bucket, s3_prefix) = parse_s3_url(&s3_url)
            .with_context(|| format!("Failed to parse APT_AWSCLI_V2_S3_URL: {s3_url}"))?;

        let ssm_param = require_env("APT_AWSCLI_V2_SSM_PARAM")?;
        let email = require_env("APT_AWSCLI_V2_EMAIL")?;
        let name = require_env("APT_AWSCLI_V2_NAME")?;

        // -1 means "no limit"; any non-positive value other than -1 is rejected to
        // avoid silently wiping the pool (max_versions=0) or wrapping negatives into
        // a huge usize via `as` cast.
        let max_versions = match opt_env("APT_AWSCLI_V2_MAX_VERSIONS") {
            None => None,
            Some(s) => {
                let n: i64 = s
                    .parse()
                    .context("APT_AWSCLI_V2_MAX_VERSIONS is not a valid number")?;
                if n == -1 {
                    None
                } else if n < 1 {
                    anyhow::bail!(
                        "APT_AWSCLI_V2_MAX_VERSIONS must be -1 (unlimited) or >= 1, got {n}"
                    );
                } else {
                    Some(n as usize)
                }
            }
        };

        let archs: Vec<String> = opt_env("APT_AWSCLI_V2_ARCHS")
            .map(|s| {
                s.split(',')
                    .map(|a| a.trim().to_string())
                    .filter(|a| !a.is_empty())
                    .collect()
            })
            .unwrap_or_else(|| vec!["amd64".to_string()]);
        if archs.is_empty() {
            anyhow::bail!("APT_AWSCLI_V2_ARCHS must contain at least one architecture");
        }

        let packages: Vec<Package> = opt_env("APT_AWSCLI_V2_PACKAGES")
            .unwrap_or_else(|| "aws-cli".to_string())
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(Package::from_str)
            .collect::<Result<Vec<_>, _>>()
            .context("APT_AWSCLI_V2_PACKAGES contains an unknown package")?;
        if packages.is_empty() {
            anyhow::bail!("APT_AWSCLI_V2_PACKAGES must contain at least one package");
        }

        let threads = opt_env("APT_AWSCLI_V2_THREADS")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(8);

        let zstd_threads = opt_env("APT_AWSCLI_V2_ZSTD_THREADS")
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(4);

        let zstd_level = opt_env("APT_AWSCLI_V2_ZSTD_LEVEL")
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or(9);

        let cf_ssm_param = opt_env("APT_AWSCLI_V2_CF_SSM_PARAM");
        let cf_zone_id = opt_env("APT_AWSCLI_V2_CF_ZONE_ID");
        let cf_public_base_url = opt_env("APT_AWSCLI_V2_CF_PUBLIC_BASE_URL");

        Ok(Config {
            s3_bucket,
            s3_prefix,
            ssm_param,
            email,
            name,
            max_versions,
            archs,
            packages,
            threads,
            zstd_threads,
            zstd_level,
            cf_ssm_param,
            cf_zone_id,
            cf_public_base_url,
        })
    }

    /// Returns the zip architecture name for the AWS CLI download URL
    pub fn zip_arch(arch: &str) -> Result<&'static str> {
        match arch {
            "amd64" => Ok("x86_64"),
            "arm64" => Ok("aarch64"),
            _ => anyhow::bail!("Unsupported architecture: {}", arch),
        }
    }

    /// Path to the local repo directory
    pub fn repo_dir(&self) -> String {
        format!("{}/repo", WORKDIR)
    }

    /// Path to the pool directory for a specific package
    pub fn pool_dir(&self, pkg_prefix: &str) -> String {
        format!("{}/repo/pool/main/{}", WORKDIR, pkg_prefix)
    }

    /// Relative path (from repo root) to the pool directory for a specific package.
    /// Used as Filename prefix in APT Packages index.
    pub fn pool_relative(&self, pkg_prefix: &str) -> String {
        format!("pool/main/{}", pkg_prefix)
    }

    /// Path to the dists directory for a specific codename
    pub fn dists_dir(&self, codename: &str) -> String {
        format!("{}/repo/dists/{}", WORKDIR, codename)
    }

    /// Path to the binary-{arch} directory within dists
    pub fn binary_arch_dir(&self, codename: &str, arch: &str) -> String {
        format!("{}/main/binary-{}", self.dists_dir(codename), arch)
    }

    /// Path to the dist (staging) directory
    pub fn dist_dir(&self) -> String {
        format!("{}/dist", WORKDIR)
    }
}

/// Get a required environment variable, treating empty strings as unset.
fn require_env(key: &str) -> Result<String> {
    opt_env(key).with_context(|| format!("{key} is not set"))
}

/// Get an optional environment variable, treating empty strings as unset.
fn opt_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

/// Parse an S3 URL (s3://bucket/prefix/) into (bucket, optional prefix)
fn parse_s3_url(url: &str) -> Result<(String, Option<String>)> {
    let url = url
        .strip_prefix("s3://")
        .context("S3 URL must start with s3://")?;

    let (bucket, prefix) = match url.find('/') {
        Some(idx) => {
            let bucket = &url[..idx];
            let prefix = url[idx + 1..].trim_end_matches('/');
            if prefix.is_empty() {
                (bucket.to_string(), None)
            } else {
                (bucket.to_string(), Some(prefix.to_string()))
            }
        }
        None => (url.to_string(), None),
    };

    Ok((bucket, prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_s3_url() {
        let (bucket, prefix) = parse_s3_url("s3://my-bucket/").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, None);

        let (bucket, prefix) = parse_s3_url("s3://my-bucket/some/prefix/").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, Some("some/prefix".to_string()));

        let (bucket, prefix) = parse_s3_url("s3://my-bucket").unwrap();
        assert_eq!(bucket, "my-bucket");
        assert_eq!(prefix, None);
    }

    #[test]
    fn test_zip_arch() {
        assert_eq!(Config::zip_arch("amd64").unwrap(), "x86_64");
        assert_eq!(Config::zip_arch("arm64").unwrap(), "aarch64");
        assert!(Config::zip_arch("i386").is_err());
    }

    #[test]
    fn test_package_from_str() {
        assert_eq!(Package::from_str("aws-cli").unwrap(), Package::AwsCli);
        assert_eq!(
            Package::from_str("session-manager-plugin").unwrap(),
            Package::SessionManagerPlugin
        );
        assert!(Package::from_str("unknown").is_err());
        // trim whitespace
        assert_eq!(Package::from_str("  aws-cli  ").unwrap(), Package::AwsCli);
    }

    #[test]
    fn test_package_file_prefix() {
        assert_eq!(Package::AwsCli.file_prefix(), "awscli-v2");
        assert_eq!(
            Package::SessionManagerPlugin.file_prefix(),
            "session-manager-plugin"
        );
    }
}
