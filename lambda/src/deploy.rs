use std::path::Path;

use anyhow::{Context, Result};
use aws_sdk_s3::Client as S3Client;
use aws_sdk_ssm::Client as SsmClient;
use chrono::{DateTime, Utc};
use tracing::info;

use crate::config::{Config, Package};
use crate::{apt_index, s3_sync, sign};

/// Deploy all packages: prune old versions, regenerate indexes, sign, and sync to S3.
/// `packages_with_dates` is a list of (package, release_date) pairs.
pub async fn deploy_all(
    config: &Config,
    s3_client: &S3Client,
    ssm_client: &SsmClient,
    packages_with_dates: &[(Package, String, DateTime<Utc>)],
) -> Result<()> {
    let repo_dir = config.repo_dir();

    // Load signer once (single SSM access)
    let signer = sign::Signer::from_ssm(ssm_client, &config.ssm_param).await?;

    // Generate public.key if not present (first run or empty S3)
    let public_key_path = format!("{repo_dir}/public.key");
    if !Path::new(&public_key_path).exists() {
        info!("public.key not found, extracting from private key...");
        let public_key = signer.public_key_armored()?;
        std::fs::write(&public_key_path, public_key).context("Failed to write public.key")?;
        info!("public.key written to {public_key_path}");
    }

    // Per-package: prune and collect pool dirs
    let mut pool_dirs: Vec<(String, String)> = Vec::new(); // (pool_dir, pool_relative)
    for (pkg, _, _release_date) in packages_with_dates {
        let file_prefix = pkg.file_prefix();
        let pool_dir = config.pool_dir(file_prefix);
        let pool_relative = config.pool_relative(file_prefix);

        std::fs::create_dir_all(&pool_dir)?;

        // Prune old versions if MAX_VERSIONS is set (per architecture)
        if let Some(max_versions) = config.max_versions {
            for arch in &config.archs {
                prune_old_versions(&pool_dir, arch, max_versions)?;
            }
        }

        pool_dirs.push((pool_dir, pool_relative));
    }

    // Combined `stable` dist: all packages in one Packages index
    {
        let stable_dists_dir = config.dists_dir("stable");
        std::fs::create_dir_all(&stable_dists_dir)?;

        let pool_entries: Vec<(&str, &str)> = pool_dirs
            .iter()
            .map(|(d, r)| (d.as_str(), r.as_str()))
            .collect();

        for arch in &config.archs {
            let binary_arch_dir = config.binary_arch_dir("stable", arch);
            std::fs::create_dir_all(&binary_arch_dir)?;

            info!("Generating Packages index for stable/{arch}...");
            apt_index::generate_packages(&pool_entries, &binary_arch_dir, arch)?;
        }

        // Use the most recent release date across all packages
        let stable_date = packages_with_dates
            .iter()
            .map(|(_, _, date)| *date)
            .max()
            .unwrap_or_else(Utc::now);

        info!("Generating Release file for stable...");
        apt_index::generate_release(
            &stable_dists_dir,
            &config.archs,
            stable_date,
            "stable",
            "AWS Tools APT Repository (Unofficial)",
        )?;

        let release_path = format!("{stable_dists_dir}/Release");
        let inrelease_path = format!("{stable_dists_dir}/InRelease");
        signer.clearsign(&release_path, &inrelease_path)?;
    }

    // 5. Sync to S3 (once for all packages)
    info!("Syncing to S3...");
    let metadata_rules = [
        // .deb packages are immutable since the filename includes the version
        s3_sync::MetadataRule {
            pattern: "pool/**".to_string(),
            metadata: s3_sync::ObjectMetadata {
                cache_control: Some("public, max-age=31536000, immutable".to_string()),
                content_type: None,
            },
        },
        // Public key is effectively immutable
        s3_sync::MetadataRule {
            pattern: "public.key".to_string(),
            metadata: s3_sync::ObjectMetadata {
                cache_control: Some("public, max-age=31536000, immutable".to_string()),
                content_type: None,
            },
        },
        // Do not cache metadata files (prevent hash mismatch)
        s3_sync::MetadataRule {
            pattern: "dists/**".to_string(),
            metadata: s3_sync::ObjectMetadata {
                cache_control: Some("no-store".to_string()),
                content_type: None,
            },
        },
    ];
    s3_sync::upload(
        s3_client,
        &config.s3_bucket,
        config.s3_prefix.as_deref(),
        Path::new(&repo_dir),
        config.threads,
        &metadata_rules,
    )
    .await?;

    info!("Deploy complete.");
    Ok(())
}

/// Remove old versions from the per-package pool directory for a specific architecture,
/// keeping only the most recent `max_versions`.
fn prune_old_versions(pool_dir: &str, arch: &str, max_versions: usize) -> Result<()> {
    let mut debs: Vec<String> = Vec::new();
    let suffix = format!("_{arch}.deb");

    if Path::new(pool_dir).exists() {
        for entry in std::fs::read_dir(pool_dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(&suffix) {
                debs.push(name);
            }
        }
    }

    if debs.len() <= max_versions {
        return Ok(());
    }

    // Sort by version (natural sort - deb names are {pkg_prefix}_{version}-1_{arch}.deb)
    debs.sort_by(|a, b| version_sort_key(a).cmp(&version_sort_key(b)));

    let to_remove = debs.len() - max_versions;
    for deb_name in debs.iter().take(to_remove) {
        let path = format!("{pool_dir}/{deb_name}");
        info!("Removing old version: {deb_name}");
        std::fs::remove_file(&path).with_context(|| format!("Failed to remove {path}"))?;
    }

    Ok(())
}

/// Extract a sortable version key from a deb filename.
/// awscli-v2_2.15.30-1_amd64.deb -> (2, 15, 30)
/// session-manager-plugin_1.2.707.0-1_amd64.deb -> (1, 2, 707, 0)
fn version_sort_key(deb_name: &str) -> Vec<u64> {
    // Extract version part: between first '_' and '-1_'
    let parts: Vec<&str> = deb_name.splitn(2, '_').collect();
    if parts.len() < 2 {
        return Vec::new();
    }
    let version_part = parts[1].split('-').next().unwrap_or("");
    version_part
        .split('.')
        .filter_map(|s| s.parse::<u64>().ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_sort_key() {
        let key = version_sort_key("awscli-v2_2.15.30-1_amd64.deb");
        assert_eq!(key, vec![2, 15, 30]);

        let key = version_sort_key("awscli-v2_2.9.1-1_amd64.deb");
        assert_eq!(key, vec![2, 9, 1]);

        let key = version_sort_key("session-manager-plugin_1.2.707.0-1_amd64.deb");
        assert_eq!(key, vec![1, 2, 707, 0]);

        // Legacy SMP naming without revision: trailing ".0_amd64" segment
        // fails u64 parse, so last component is lost — but sort order is still
        // correct because the first three components are sufficient to
        // distinguish all known SMP versions.
        let key = version_sort_key("session-manager-plugin_1.2.707.0_amd64.deb");
        assert_eq!(key, vec![1, 2, 707]);
    }

    #[test]
    fn test_version_ordering() {
        let mut debs = vec![
            "awscli-v2_2.15.30-1_amd64.deb".to_string(),
            "awscli-v2_2.9.1-1_amd64.deb".to_string(),
            "awscli-v2_2.15.2-1_amd64.deb".to_string(),
        ];
        debs.sort_by(|a, b| version_sort_key(a).cmp(&version_sort_key(b)));
        assert_eq!(
            debs,
            vec![
                "awscli-v2_2.9.1-1_amd64.deb",
                "awscli-v2_2.15.2-1_amd64.deb",
                "awscli-v2_2.15.30-1_amd64.deb",
            ]
        );
    }

    #[test]
    fn test_prune_old_versions() {
        let dir = tempfile::tempdir().unwrap();
        let pool_dir = dir.path().to_str().unwrap();

        // Create test deb files for amd64
        for name in &[
            "awscli-v2_2.9.1-1_amd64.deb",
            "awscli-v2_2.15.2-1_amd64.deb",
            "awscli-v2_2.15.30-1_amd64.deb",
        ] {
            std::fs::write(format!("{pool_dir}/{name}"), b"test").unwrap();
        }

        // Create test deb files for arm64 (should not be affected)
        std::fs::write(format!("{pool_dir}/awscli-v2_2.9.1-1_arm64.deb"), b"test").unwrap();

        prune_old_versions(pool_dir, "amd64", 2).unwrap();

        // Should have removed the oldest amd64 version
        assert!(!Path::new(&format!("{pool_dir}/awscli-v2_2.9.1-1_amd64.deb")).exists());
        assert!(Path::new(&format!("{pool_dir}/awscli-v2_2.15.2-1_amd64.deb")).exists());
        assert!(Path::new(&format!("{pool_dir}/awscli-v2_2.15.30-1_amd64.deb")).exists());

        // arm64 should be untouched
        assert!(Path::new(&format!("{pool_dir}/awscli-v2_2.9.1-1_arm64.deb")).exists());
    }
}
