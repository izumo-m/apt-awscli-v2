use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result};

/// Build a .deb package from a staging directory.
///
/// The staging directory must contain:
/// - `DEBIAN/` directory with control files (control, postinst, etc.)
/// - Other directories/files that become the package data
///
/// deb format = ar archive containing:
/// 1. `debian-binary` - format version "2.0\n"
/// 2. `control.tar.zst` - DEBIAN/ contents compressed with zstd
/// 3. `data.tar.zst` - everything except DEBIAN/ compressed with zstd
pub fn build_deb(staging_dir: &Path, output_path: &Path, threads: u32, level: i32) -> Result<()> {
    let debian_binary = b"2.0\n";

    // Build control.tar.zst
    let control_tar_zst = {
        let debian_dir = staging_dir.join("DEBIAN");
        let compressed = Vec::new();
        let mut encoder = zstd::Encoder::new(compressed, level)?;
        encoder.multithread(threads)?;
        {
            let mut builder = tar::Builder::new(&mut encoder);
            add_dir_to_tar(&mut builder, &debian_dir, &debian_dir, None)?;
            builder.finish()?;
        }
        encoder.finish()?
    };

    // Build data.tar.zst — stream tar directly into zstd with multi-threading
    let data_tar_zst = {
        let compressed = Vec::new();
        let mut encoder = zstd::Encoder::new(compressed, level)?;
        encoder.multithread(threads)?;
        {
            let mut builder = tar::Builder::new(&mut encoder);
            add_dir_to_tar(&mut builder, staging_dir, staging_dir, Some("DEBIAN"))?;
            builder.finish()?;
        }
        encoder.finish()?
    };

    // Create ar archive
    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let output_file = std::fs::File::create(output_path)
        .with_context(|| format!("Failed to create {}", output_path.display()))?;
    let mut archive = ar::Builder::new(output_file);

    archive.append(
        &ar_header(b"debian-binary", debian_binary.len() as u64),
        &debian_binary[..],
    )?;
    archive.append(
        &ar_header(b"control.tar.zst", control_tar_zst.len() as u64),
        control_tar_zst.as_slice(),
    )?;
    archive.append(
        &ar_header(b"data.tar.zst", data_tar_zst.len() as u64),
        data_tar_zst.as_slice(),
    )?;

    Ok(())
}

fn ar_header(name: &[u8], size: u64) -> ar::Header {
    let mut h = ar::Header::new(name.to_vec(), size);
    h.set_mode(0o100644);
    h.set_uid(0);
    h.set_gid(0);
    h.set_mtime(0);
    h
}

fn add_dir_to_tar<W: Write>(
    builder: &mut tar::Builder<W>,
    dir: &Path,
    base: &Path,
    exclude: Option<&str>,
) -> Result<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();

        // Skip the excluded directory at the top level
        if let Some(ex) = exclude {
            if dir == base && name.to_string_lossy() == ex {
                continue;
            }
        }

        let relative = path.strip_prefix(base)?;
        let archive_path = Path::new(".").join(relative);

        if path.is_symlink() {
            let link_target = std::fs::read_link(&path)?;
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_mode(0o777);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_size(0);
            header.set_cksum();
            builder.append_link(&mut header, &archive_path, &link_target)?;

            // Do not recurse into symlinked directories
            if path.is_dir() {
                continue;
            }
        } else if path.is_dir() {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_size(0);
            header.set_cksum();
            builder.append_data(&mut header, &archive_path, &[] as &[u8])?;

            add_dir_to_tar(builder, &path, base, exclude)?;
        } else {
            let data = std::fs::read(&path)?;
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            let metadata = std::fs::metadata(&path)?;
            let mode = if is_executable(&metadata) {
                0o755
            } else {
                0o644
            };
            header.set_mode(mode);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_size(data.len() as u64);
            header.set_cksum();
            builder.append_data(&mut header, &archive_path, data.as_slice())?;
        }
    }

    Ok(())
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
    false
}
