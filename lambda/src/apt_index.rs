use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};
use flate2::write::GzEncoder;
use flate2::Compression;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tracing::info;

/// Generate Packages and Packages.gz combining one or more per-package pool directories.
/// Reuses cached Packages entries where possible (matched by Filename + Size).
pub fn generate_packages(pool_entries: &[(&str, &str)], binary_arch_dir: &str, arch: &str) -> Result<String> {
    let suffix = format!("_{arch}.deb");

    // Parse existing Packages file to reuse cached entries
    let packages_path = format!("{binary_arch_dir}/Packages");
    let existing_entries = if Path::new(&packages_path).exists() {
        let data = std::fs::read_to_string(&packages_path)?;
        parse_packages(&data)
    } else {
        HashMap::new()
    };

    // Collect .deb files from all pool directories: (deb_name, pool_dir, pool_relative)
    let mut deb_entries: Vec<(String, &str, &str)> = Vec::new();
    for (pool_dir, pool_relative) in pool_entries {
        if Path::new(pool_dir).exists() {
            for entry in std::fs::read_dir(pool_dir)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(&suffix) {
                    deb_entries.push((name, pool_dir, pool_relative));
                }
            }
        }
    }
    deb_entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut packages_content = String::new();

    for (deb_name, pool_dir, pool_relative) in &deb_entries {
        let filename = format!("{pool_relative}/{deb_name}");

        // Reuse cached entry if Filename and Size match
        if let Some(existing) = existing_entries.get(&filename) {
            let deb_path = format!("{pool_dir}/{deb_name}");
            let current_size = std::fs::metadata(&deb_path)?.len();

            if let Some(entry_size) = extract_field(existing, "Size") {
                if entry_size == current_size.to_string() {
                    info!("Using existing Packages entry for {deb_name}");
                    packages_content.push_str(existing);
                    if !existing.ends_with('\n') {
                        packages_content.push('\n');
                    }
                    packages_content.push('\n');
                    continue;
                }
            }
        }

        // New or changed deb — scan it
        let deb_path = format!("{pool_dir}/{deb_name}");
        let file_size = std::fs::metadata(&deb_path)?.len();

        info!("Scanning new deb: {deb_name}");
        let entry = scan_deb(&deb_path, file_size)?;

        packages_content.push_str(&entry.control);
        if !entry.control.ends_with('\n') {
            packages_content.push('\n');
        }
        packages_content.push_str(&format!("Filename: {filename}\n"));
        packages_content.push_str(&format!("Size: {}\n", entry.size));
        packages_content.push_str(&format!("MD5sum: {}\n", entry.md5));
        packages_content.push_str(&format!("SHA1: {}\n", entry.sha1));
        packages_content.push_str(&format!("SHA256: {}\n", entry.sha256));
        packages_content.push('\n');
    }

    // Write Packages file
    std::fs::write(&packages_path, &packages_content)?;

    // Write Packages.gz
    let packages_gz_path = format!("{binary_arch_dir}/Packages.gz");
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    std::io::Write::write_all(&mut encoder, packages_content.as_bytes())?;
    let compressed = encoder.finish()?;
    std::fs::write(&packages_gz_path, &compressed)?;

    Ok(packages_content)
}

/// Parse a Packages file into a map of Filename -> full entry text.
fn parse_packages(data: &str) -> HashMap<String, String> {
    let mut entries = HashMap::new();

    for block in data.split("\n\n") {
        let block = block.trim();
        if block.is_empty() {
            continue;
        }
        if let Some(filename) = extract_field(block, "Filename") {
            entries.insert(filename, block.to_string());
        }
    }

    entries
}

/// Extract a field value from a Packages entry block.
fn extract_field(block: &str, field: &str) -> Option<String> {
    let prefix = format!("{field}: ");
    for line in block.lines() {
        if let Some(value) = line.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
    }
    None
}

struct DebMetadata {
    size: u64,
    md5: String,
    sha1: String,
    sha256: String,
    control: String,
}

/// Compute MD5, SHA1, SHA256 hashes of a byte slice in parallel using threads.
fn compute_hashes(data: &[u8]) -> (String, String, String) {
    std::thread::scope(|s| {
        let h_md5 = s.spawn(|| format!("{:x}", md5::Md5::digest(data)));
        let h_sha1 = s.spawn(|| format!("{:x}", Sha1::digest(data)));
        let h_sha256 = s.spawn(|| format!("{:x}", Sha256::digest(data)));
        (
            h_md5.join().unwrap(),
            h_sha1.join().unwrap(),
            h_sha256.join().unwrap(),
        )
    })
}

/// Scan a .deb file to extract control metadata and compute hashes.
fn scan_deb(deb_path: &str, file_size: u64) -> Result<DebMetadata> {
    let deb_data = std::fs::read(deb_path)
        .with_context(|| format!("Failed to read {deb_path}"))?;

    // Compute hashes of the whole deb (in parallel)
    let (md5, sha1, sha256) = compute_hashes(&deb_data);

    // Extract control file from deb (ar -> control.tar.zst -> ./control)
    let control = extract_control_from_deb(&deb_data)
        .with_context(|| format!("Failed to extract control from {deb_path}"))?;

    Ok(DebMetadata {
        size: file_size,
        md5,
        sha1,
        sha256,
        control,
    })
}

/// Extract the control file content from a .deb archive.
/// deb = ar archive containing control.tar.{zst,gz,xz} which contains ./control
fn extract_control_from_deb(deb_data: &[u8]) -> Result<String> {
    let cursor = std::io::Cursor::new(deb_data);
    let mut ar_archive = ar::Archive::new(cursor);

    while let Some(entry) = ar_archive.next_entry() {
        let mut entry = entry?;
        let name = std::str::from_utf8(entry.header().identifier())?.to_string();

        let tar_data: Vec<u8> = if name == "control.tar.zst" || name.starts_with("control.tar.zst/") {
            let mut compressed = Vec::new();
            entry.read_to_end(&mut compressed)?;
            zstd::decode_all(compressed.as_slice())
                .context("Failed to decompress control.tar.zst")?
        } else if name == "control.tar.gz" || name.starts_with("control.tar.gz/") {
            let mut compressed = Vec::new();
            entry.read_to_end(&mut compressed)?;
            let mut decoder = flate2::read::GzDecoder::new(compressed.as_slice());
            let mut buf = Vec::new();
            std::io::Read::read_to_end(&mut decoder, &mut buf)
                .context("Failed to decompress control.tar.gz")?;
            buf
        } else {
            continue;
        };

        // Extract ./control from tar
        let mut tar_archive = tar::Archive::new(tar_data.as_slice());
        for tar_entry in tar_archive.entries()? {
            let mut tar_entry = tar_entry?;
            let path = tar_entry.path()?.to_string_lossy().to_string();
            if path == "./control" || path == "control" {
                let mut control = String::new();
                tar_entry.read_to_string(&mut control)?;
                return Ok(control.trim_end().to_string());
            }
        }

        anyhow::bail!("control file not found in {name}");
    }

    anyhow::bail!("control.tar.{{zst,gz}} not found in deb archive");
}

const RELEASE_TEMPLATE: &str = include_str!("../metadata/Release");

/// Generate the Release file for the APT repository.
/// Covers all architectures, with hashes for each binary-{arch}/Packages[.gz].
pub fn generate_release(
    dists_dir: &str,
    archs: &[String],
    date: chrono::DateTime<chrono::Utc>,
    codename: &str,
    label: &str,
) -> Result<()> {
    // Template expansion
    let archs_str = archs.join(" ");
    let mut release = RELEASE_TEMPLATE
        .replace("${ARCHS}", &archs_str)
        .replace("${CODENAME}", codename)
        .replace("${LABEL}", label);

    // Date field (RFC 2822 format, required by apt)
    release.push_str(&format!(
        "Date: {}\n",
        date.format("%a, %d %b %Y %H:%M:%S UTC")
    ));

    // Compute hashes for each architecture's Packages and Packages.gz
    let mut hash_entries_md5 = String::new();
    let mut hash_entries_sha1 = String::new();
    let mut hash_entries_sha256 = String::new();

    for arch in archs {
        for name in &["Packages", "Packages.gz"] {
            let relative = format!("main/binary-{arch}/{name}");
            let path = format!("{dists_dir}/{relative}");

            if !Path::new(&path).exists() {
                continue;
            }
            let data = std::fs::read(&path)?;
            let size = data.len();
            let (md5, sha1, sha256) = compute_hashes(&data);

            hash_entries_md5.push_str(&format!(" {md5} {size:>16} {relative}\n"));
            hash_entries_sha1.push_str(&format!(" {sha1} {size:>16} {relative}\n"));
            hash_entries_sha256.push_str(&format!(" {sha256} {size:>16} {relative}\n"));
        }
    }

    release.push_str(&format!("MD5Sum:\n{hash_entries_md5}"));
    release.push_str(&format!("SHA1:\n{hash_entries_sha1}"));
    release.push_str(&format!("SHA256:\n{hash_entries_sha256}"));

    let release_path = format!("{dists_dir}/Release");
    std::fs::write(&release_path, &release)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_packages() {
        let data = "Package: awscli-v2\nVersion: 2.15.30-1\nFilename: pool/main/awscli-v2_2.15.30-1_amd64.deb\nSize: 12345\n\nPackage: awscli-v2\nVersion: 2.15.31-1\nFilename: pool/main/awscli-v2_2.15.31-1_amd64.deb\nSize: 12346\n\n";
        let entries = parse_packages(data);
        assert_eq!(entries.len(), 2);
        assert!(entries.contains_key("pool/main/awscli-v2_2.15.30-1_amd64.deb"));
        assert!(entries.contains_key("pool/main/awscli-v2_2.15.31-1_amd64.deb"));
    }

    #[test]
    fn test_extract_field() {
        let block = "Package: awscli-v2\nVersion: 2.15.30-1\nFilename: pool/main/awscli-v2_2.15.30-1_amd64.deb\nSize: 12345";
        assert_eq!(extract_field(block, "Filename"), Some("pool/main/awscli-v2_2.15.30-1_amd64.deb".to_string()));
        assert_eq!(extract_field(block, "Size"), Some("12345".to_string()));
        assert_eq!(extract_field(block, "NonExistent"), None);
    }

    #[test]
    fn test_generate_release() {
        let dir = tempfile::tempdir().unwrap();
        let dists_dir = dir.path().to_str().unwrap();

        // Create binary-amd64 directory with a Packages file
        let binary_dir = format!("{dists_dir}/main/binary-amd64");
        std::fs::create_dir_all(&binary_dir).unwrap();
        std::fs::write(format!("{binary_dir}/Packages"), "test content").unwrap();
        std::fs::write(format!("{binary_dir}/Packages.gz"), "compressed").unwrap();

        let archs = vec!["amd64".to_string()];
        let date = chrono::Utc::now();
        generate_release(dists_dir, &archs, date, "awscli-v2", "AWS CLI v2 APT Repository (Unofficial)").unwrap();

        let release = std::fs::read_to_string(format!("{dists_dir}/Release")).unwrap();
        assert!(release.contains("Codename: awscli-v2"));
        assert!(release.contains("Label: AWS CLI v2 APT Repository (Unofficial)"));
        assert!(release.contains("Architectures: amd64"));
        assert!(release.contains("Components: main"));
        assert!(release.contains("main/binary-amd64/Packages"));
        assert!(release.contains("MD5Sum:"));
        assert!(release.contains("SHA1:"));
        assert!(release.contains("SHA256:"));
    }
}
