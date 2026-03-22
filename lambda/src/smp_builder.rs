use std::path::Path;

use anyhow::{Context, Result};
use tracing::info;

use crate::config::Config;

/// Download a Session Manager Plugin .deb for the given version and architecture.
/// Returns true if the file was downloaded (new), false if it already existed.
pub async fn build(config: &Config, version: &str, arch: &str) -> Result<bool> {
    let deb_name = format!("session-manager-plugin_{version}_{arch}.deb");
    let pool_dir = config.pool_dir("session-manager-plugin");
    let deb_path = format!("{pool_dir}/{deb_name}");

    // Skip if already downloaded
    if Path::new(&deb_path).exists() {
        info!("Already downloaded: {deb_path}, skipping.");
        return Ok(false);
    }

    let url = smp_download_url(version, arch)?;

    info!("Downloading Session Manager Plugin {version} ({arch}) from {url}...");
    let response = reqwest::get(&url)
        .await
        .with_context(|| format!("Failed to download {url}"))?;

    if !response.status().is_success() {
        anyhow::bail!("Download failed with status {}: {url}", response.status());
    }

    let deb_data = response
        .bytes()
        .await
        .with_context(|| format!("Failed to read response body from {url}"))?;

    std::fs::create_dir_all(&pool_dir)?;
    std::fs::write(&deb_path, &deb_data)
        .with_context(|| format!("Failed to write {deb_path}"))?;

    let deb_size = deb_data.len();
    info!("Done: {deb_path} ({:.1} MB)", deb_size as f64 / 1_000_000.0);
    Ok(true)
}

fn smp_download_url(version: &str, arch: &str) -> Result<String> {
    let url_arch = match arch {
        "amd64" => "ubuntu_64bit",
        "arm64" => "ubuntu_arm64",
        other => anyhow::bail!("Unsupported architecture for Session Manager Plugin: {}", other),
    };
    Ok(format!(
        "https://s3.amazonaws.com/session-manager-downloads/plugin/{version}/{url_arch}/session-manager-plugin.deb"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_smp_download_url() {
        let url = smp_download_url("1.2.707.0", "amd64").unwrap();
        assert_eq!(
            url,
            "https://s3.amazonaws.com/session-manager-downloads/plugin/1.2.707.0/ubuntu_64bit/session-manager-plugin.deb"
        );

        let url = smp_download_url("1.2.707.0", "arm64").unwrap();
        assert_eq!(
            url,
            "https://s3.amazonaws.com/session-manager-downloads/plugin/1.2.707.0/ubuntu_arm64/session-manager-plugin.deb"
        );

        assert!(smp_download_url("1.2.707.0", "i386").is_err());
    }
}
