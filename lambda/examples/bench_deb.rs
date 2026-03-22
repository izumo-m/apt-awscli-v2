//! Benchmark for deb package creation
//!
//! Creates a deb package using APT_AWSCLI_V2_WORKDIR/dist as input and measures time and size.
//! If dist does not exist, downloads and extracts the AWS CLI zip to prepare it.
//!
//! Usage:
//!   cargo run --release --example bench_deb
//!
//! Environment variables (all optional):
//!   APT_AWSCLI_V2_WORKDIR  Working directory (default: /tmp)
//!   APT_AWSCLI_V2_ARCH     Architecture     (default: amd64)
//!   VERSION                 AWS CLI version  (default: latest)

use std::path::Path;
use std::time::Instant;

use anyhow::{Context, Result};

fn main() -> Result<()> {
    let workdir = std::env::var("APT_AWSCLI_V2_WORKDIR").unwrap_or_else(|_| "/tmp".to_string());
    let arch = std::env::var("APT_AWSCLI_V2_ARCH").unwrap_or_else(|_| "amd64".to_string());
    let dist_dir = format!("{workdir}/dist");
    let output_path = format!("{workdir}/awscliv2.deb");

    // Prepare dist if it doesn't exist
    if !Path::new(&dist_dir).join("DEBIAN/control").exists() {
        prepare_dist(&dist_dir, &arch)?;
    } else {
        eprintln!("Using existing dist: {dist_dir}");
    }

    // Benchmark deb creation
    eprintln!("Building deb from {dist_dir} ...");
    let start = Instant::now();
    let zstd_threads: u32 = std::env::var("APT_AWSCLI_V2_ZSTD_THREADS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2);
    let zstd_level: i32 = std::env::var("APT_AWSCLI_V2_ZSTD_LEVEL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9);
    apt_awscli_v2_lambda::deb::build_deb(
        Path::new(&dist_dir),
        Path::new(&output_path),
        zstd_threads,
        zstd_level,
    )?;
    let elapsed = start.elapsed();

    let size = std::fs::metadata(&output_path)?.len();
    eprintln!("Output: {output_path}");
    eprintln!("Size:   {} bytes ({:.2} MB)", size, size as f64 / 1_048_576.0);
    eprintln!("Time:   {:.3}s", elapsed.as_secs_f64());

    Ok(())
}

/// Prepare the dist directory (download and extract the AWS CLI zip)
fn prepare_dist(dist_dir: &str, arch: &str) -> Result<()> {
    let version = match std::env::var("VERSION") {
        Ok(v) if !v.is_empty() => v,
        _ => {
            eprintln!("Fetching latest version ...");
            let rt = tokio::runtime::Runtime::new()?;
            rt.block_on(apt_awscli_v2_lambda::version::fetch_latest_version())?.0
        }
    };

    let zip_arch = match arch {
        "amd64" => "x86_64",
        "arm64" => "aarch64",
        other => anyhow::bail!("Unsupported architecture: {other}"),
    };
    let url = format!(
        "https://awscli.amazonaws.com/awscli-exe-linux-{zip_arch}-{version}.zip"
    );

    // Download
    eprintln!("Downloading {url} ...");
    let zip_data = reqwest::blocking::get(&url)
        .with_context(|| format!("Failed to download {url}"))?
        .bytes()
        .with_context(|| format!("Failed to read response from {url}"))?;
    eprintln!("Downloaded {} bytes ({:.2} MB)", zip_data.len(), zip_data.len() as f64 / 1_048_576.0);

    // Extract
    eprintln!("Extracting ...");
    let _ = std::fs::remove_dir_all(dist_dir);
    let opt_dir = format!("{dist_dir}/opt/awscli-v2");
    std::fs::create_dir_all(&opt_dir)?;

    let cursor = std::io::Cursor::new(&zip_data);
    let mut archive = zip::ZipArchive::new(cursor)?;
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
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(mode))?;
                }
            }
        }
    }

    // DEBIAN directory
    let debian_dir = format!("{dist_dir}/DEBIAN");
    std::fs::create_dir_all(&debian_dir)?;

    let pkg_version = format!("{version}-1");
    let control = include_str!("../metadata/DEBIAN/control")
        .replace("${VERSION}", &pkg_version)
        .replace("${ARCH}", arch)
        .replace("${APT_AWSCLI_V2_NAME}", "Test")
        .replace("${APT_AWSCLI_V2_EMAIL}", "test@example.com");
    std::fs::write(format!("{debian_dir}/control"), &control)?;

    std::fs::write(
        format!("{debian_dir}/postinst"),
        include_str!("../metadata/DEBIAN/postinst"),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            format!("{debian_dir}/postinst"),
            std::fs::Permissions::from_mode(0o755),
        )?;
    }

    eprintln!("Prepared dist: {dist_dir}");
    Ok(())
}
