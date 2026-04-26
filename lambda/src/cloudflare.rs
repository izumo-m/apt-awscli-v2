//! Cloudflare cache purge client.
//!
//! The SSM SecureString parameter holds only the API token:
//!
//! ```json
//! { "api_token": "..." }
//! ```
//!
//! Non-secret identifiers (`zone_id`, `public_base_url`) come from Lambda
//! environment variables set by Pulumi. This minimises both:
//!   - the SSM blast radius (only the secret value lives there), and
//!   - what flows through Pulumi state (no secret ever serialised).
//!
//! On the Cloudflare Free plan, per-URL purge is limited to 30 URLs per
//! request, so `purge_keys` automatically batches.

use std::time::Duration;

use anyhow::{Context, Result};
use aws_sdk_ssm::Client as SsmClient;
use serde::{Deserialize, Serialize};
use tracing::info;

const PURGE_BATCH_SIZE: usize = 30;
const HTTP_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Deserialize)]
struct SsmCredentials {
    api_token: String,
}

pub struct CloudflarePurger {
    api_token: String,
    zone_id: String,
    public_base_url: String,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct PurgeBody<'a> {
    files: &'a [String],
}

#[derive(Deserialize)]
struct PurgeResponse {
    success: bool,
}

impl CloudflarePurger {
    /// Fetch the API token from SSM and construct a purger.
    /// `zone_id` and `public_base_url` come from Lambda env vars
    /// (non-secret identifiers set by Pulumi).
    pub async fn from_ssm(
        ssm_client: &SsmClient,
        ssm_param: &str,
        zone_id: String,
        public_base_url: String,
    ) -> Result<Self> {
        if zone_id.is_empty() {
            anyhow::bail!("Cloudflare zone_id is empty");
        }
        if public_base_url.is_empty() {
            anyhow::bail!("Cloudflare public_base_url is empty");
        }

        info!("Fetching Cloudflare API token from SSM: {ssm_param}");
        let resp = ssm_client
            .get_parameter()
            .name(ssm_param)
            .with_decryption(true)
            .send()
            .await
            .context("Failed to get SSM parameter for Cloudflare API token")?;
        let json = resp
            .parameter()
            .and_then(|p| p.value())
            .context("SSM parameter for Cloudflare has no value")?;
        let creds: SsmCredentials = serde_json::from_str(json)
            .context("Failed to parse Cloudflare API token JSON from SSM")?;
        if creds.api_token.is_empty() {
            anyhow::bail!("Cloudflare api_token in SSM is empty");
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
            .build()
            .context("Failed to build HTTP client")?;
        Ok(Self {
            api_token: creds.api_token,
            zone_id,
            public_base_url,
            http,
        })
    }

    /// Convert S3 keys to public URLs and purge them in batches of 30.
    /// `s3_prefix` is stripped from each key before joining with `public_base_url`.
    pub async fn purge_keys(&self, keys: &[String], s3_prefix: Option<&str>) -> Result<()> {
        let mut urls: Vec<String> = keys
            .iter()
            .map(|k| key_to_url(&self.public_base_url, k, s3_prefix))
            .collect();
        urls.sort();
        urls.dedup();

        if urls.is_empty() {
            return Ok(());
        }

        info!(
            "Purging {} URL(s) from Cloudflare in batches of {}",
            urls.len(),
            PURGE_BATCH_SIZE
        );
        for batch in urls.chunks(PURGE_BATCH_SIZE) {
            self.purge_batch(batch).await?;
        }
        Ok(())
    }

    async fn purge_batch(&self, batch: &[String]) -> Result<()> {
        let body = serde_json::to_string(&PurgeBody { files: batch })
            .context("Failed to serialize purge body")?;
        let url = format!(
            "https://api.cloudflare.com/client/v4/zones/{}/purge_cache",
            self.zone_id
        );
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_token)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .context("Failed to send Cloudflare purge request")?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            anyhow::bail!("Cloudflare purge HTTP {status}: {text}");
        }
        let parsed: PurgeResponse = serde_json::from_str(&text)
            .with_context(|| format!("Failed to parse Cloudflare response: {text}"))?;
        if !parsed.success {
            anyhow::bail!("Cloudflare purge returned success=false: {text}");
        }
        info!("Cloudflare purge batch ok ({} URLs)", batch.len());
        Ok(())
    }
}

/// Strip `{s3_prefix}/` from `key` and join with `base` to form a public URL.
fn key_to_url(base: &str, key: &str, s3_prefix: Option<&str>) -> String {
    let base = base.trim_end_matches('/');
    let relative = match s3_prefix {
        Some(p) => {
            let trimmed = p.trim_end_matches('/');
            if trimmed.is_empty() {
                key
            } else {
                let p_with_slash = format!("{trimmed}/");
                key.strip_prefix(&p_with_slash).unwrap_or(key)
            }
        }
        None => key,
    };
    format!("{base}/{relative}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_to_url_strips_prefix() {
        let url = key_to_url(
            "https://example.com",
            "apt/dists/stable/Release",
            Some("apt"),
        );
        assert_eq!(url, "https://example.com/dists/stable/Release");
    }

    #[test]
    fn key_to_url_with_no_prefix() {
        let url = key_to_url("https://example.com", "dists/stable/Release", None);
        assert_eq!(url, "https://example.com/dists/stable/Release");
    }

    #[test]
    fn key_to_url_strips_trailing_slash_from_base() {
        let url = key_to_url("https://example.com/", "dists/stable/Release", None);
        assert_eq!(url, "https://example.com/dists/stable/Release");
    }

    #[test]
    fn key_to_url_handles_prefix_with_trailing_slash() {
        let url = key_to_url(
            "https://example.com",
            "apt/dists/stable/Release",
            Some("apt/"),
        );
        assert_eq!(url, "https://example.com/dists/stable/Release");
    }

    #[test]
    fn key_to_url_unrelated_key_used_as_is() {
        // Defensive: keys that don't start with the prefix are emitted as-is
        // rather than panicking.
        let url = key_to_url("https://example.com", "other/file", Some("apt"));
        assert_eq!(url, "https://example.com/other/file");
    }

    #[test]
    fn key_to_url_handles_nested_prefix() {
        let url = key_to_url(
            "https://example.com",
            "deep/nested/apt/pool/main/x.deb",
            Some("deep/nested/apt"),
        );
        assert_eq!(url, "https://example.com/pool/main/x.deb");
    }
}
