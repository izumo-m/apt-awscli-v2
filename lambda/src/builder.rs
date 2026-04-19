use std::path::Path;

use anyhow::{Context, Result};
use tracing::info;

use crate::config::Config;
use crate::deb;

const CONTROL_TEMPLATE: &str = include_str!("../metadata/DEBIAN/control");
const POSTINST: &str = include_str!("../metadata/DEBIAN/postinst");

/// Build a .deb package for the given version and architecture. Returns true if a new deb was built.
pub async fn build(config: &Config, version: &str, arch: &str) -> Result<bool> {
    let pkg_version = format!("{version}-1");
    let deb_name = format!("awscli-v2_{pkg_version}_{arch}.deb");
    let pool_dir = config.pool_dir("awscli-v2");
    let deb_path = format!("{pool_dir}/{deb_name}");

    // Skip if already built
    if Path::new(&deb_path).exists() {
        info!("Already built: {deb_path}, skipping.");
        return Ok(false);
    }

    info!("Building awscli-v2 {pkg_version} ({arch})...");

    let zip_arch = Config::zip_arch(arch)?;
    let url = format!("https://awscli.amazonaws.com/awscli-exe-linux-{zip_arch}-{version}.zip");

    // Download
    info!("Downloading {url}...");
    let response = reqwest::get(&url)
        .await
        .with_context(|| format!("Failed to download {url}"))?;

    if !response.status().is_success() {
        anyhow::bail!("Download failed with status {}: {url}", response.status());
    }

    let zip_data = response
        .bytes()
        .await
        .with_context(|| format!("Failed to read response body from {url}"))?;

    // Extract zip
    info!("Extracting zip ({} bytes)...", zip_data.len());
    let dist_dir = config.dist_dir();
    let _ = std::fs::remove_dir_all(&dist_dir);

    let cursor = std::io::Cursor::new(&zip_data);
    let mut archive = zip::ZipArchive::new(cursor).context("Failed to open zip archive")?;

    // Extract aws/dist/* to {dist_dir}/opt/awscli-v2/
    let opt_dir = format!("{dist_dir}/opt/awscli-v2");
    std::fs::create_dir_all(&opt_dir)?;

    let prefix = "aws/dist/";
    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();

        if !name.starts_with(prefix) {
            continue;
        }

        let relative = &name[prefix.len()..];
        if relative.is_empty() {
            continue;
        }

        let target = format!("{opt_dir}/{relative}");

        if file.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = Path::new(&target).parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut outfile = std::fs::File::create(&target)?;
            std::io::copy(&mut file, &mut outfile)?;

            // Preserve executable permissions
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))?;
                }
            }
        }
    }

    info!("Extracted {} files to {opt_dir}", archive.len());

    // Create symlinks in /usr/bin/ (included in data.tar.zst)
    let usr_bin_dir = format!("{dist_dir}/usr/bin");
    std::fs::create_dir_all(&usr_bin_dir)?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/opt/awscli-v2/aws", format!("{usr_bin_dir}/aws"))?;
        std::os::unix::fs::symlink(
            "/opt/awscli-v2/aws_completer",
            format!("{usr_bin_dir}/aws_completer"),
        )?;
    }

    // Create DEBIAN directory with control files
    let debian_dir = format!("{dist_dir}/DEBIAN");
    std::fs::create_dir_all(&debian_dir)?;

    // Generate control file from template
    let control = CONTROL_TEMPLATE
        .replace("${VERSION}", &pkg_version)
        .replace("${ARCH}", arch)
        .replace("${APT_AWSCLI_V2_NAME}", &config.name)
        .replace("${APT_AWSCLI_V2_EMAIL}", &config.email);
    std::fs::write(format!("{debian_dir}/control"), &control)?;

    // Write postinst script
    std::fs::write(format!("{debian_dir}/postinst"), POSTINST)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            format!("{debian_dir}/postinst"),
            std::fs::Permissions::from_mode(0o755),
        )?;
    }

    // Build deb
    info!(
        "Building deb package (zstd level={}, threads={})...",
        config.zstd_level, config.zstd_threads
    );
    std::fs::create_dir_all(&pool_dir)?;
    let build_start = std::time::Instant::now();
    deb::build_deb(
        Path::new(&dist_dir),
        Path::new(&deb_path),
        config.zstd_threads,
        config.zstd_level,
    )?;
    let build_elapsed = build_start.elapsed();
    let deb_size = std::fs::metadata(&deb_path)?.len();

    // Clean up staging
    let _ = std::fs::remove_dir_all(&dist_dir);

    info!(
        "Done: {deb_path} ({:.1} MB, {:.1}s)",
        deb_size as f64 / 1_000_000.0,
        build_elapsed.as_secs_f64()
    );
    Ok(true)
}
