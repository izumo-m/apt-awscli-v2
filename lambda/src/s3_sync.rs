use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{Context, Result};
use aws_sdk_s3::primitives::{ByteStream, DateTime};
use aws_sdk_s3::Client;
use futures::stream::{self, StreamExt};
use glob::Pattern;
use tracing::info;

/// Metadata to attach to S3 objects.
pub struct ObjectMetadata {
    pub cache_control: Option<String>,
    pub content_type: Option<String>,
}

/// Result of `upload()`: which S3 keys were newly created/updated and which were deleted.
/// Both lists hold full S3 keys (with prefix applied), suitable for cache invalidation.
#[derive(Debug, Default)]
pub struct UploadResult {
    pub uploaded: Vec<String>,
    pub deleted: Vec<String>,
}

/// A pair of a path pattern (glob syntax) and metadata.
/// When passed to `upload()`, metadata is attached to files whose relative path matches.
///
/// Patterns use `glob::Pattern` syntax (`*`, `**`, `?`, `[...]`).
/// Examples: `"pool/**"`, `"dists/**"`, `"public.key"`
pub struct MetadataRule {
    pub pattern: String,
    pub metadata: ObjectMetadata,
}

/// Returns the metadata from the first matching rule in the compiled rules.
fn resolve_metadata(
    compiled: &[(Pattern, &ObjectMetadata)],
    relative: &str,
) -> (Option<String>, Option<String>) {
    compiled
        .iter()
        .find(|(pat, _)| pat.matches(relative))
        .map(|(_, meta)| (meta.cache_control.clone(), meta.content_type.clone()))
        .unwrap_or((None, None))
}

/// Metadata for an S3 object used for sync comparison.
struct ObjectMeta {
    size: i64,
    last_modified: DateTime,
}

/// Metadata for a local file used for sync comparison.
struct FileMeta {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

/// Download objects from S3 to local directory, mirroring `aws s3 sync --delete`.
/// Compares size and last-modified time to determine which files need updating.
pub async fn download(
    client: &Client,
    bucket: &str,
    prefix: Option<&str>,
    local_dir: &Path,
    concurrency: usize,
) -> Result<()> {
    let remote_objects = list_objects(client, bucket, prefix).await?;
    let local_files = list_local_files(local_dir)?;

    // Collect files to download
    let to_download: Vec<_> = remote_objects
        .iter()
        .filter_map(|(key, remote)| {
            let relative = strip_prefix(key, prefix);
            let should_download = match local_files.get(&relative) {
                None => true,
                Some(local) => {
                    local.size as i64 != remote.size
                        || remote.last_modified.secs() > mtime_to_secs(local.modified)
                }
            };
            if should_download {
                Some((key.clone(), local_dir.join(&relative), remote.last_modified))
            } else {
                None
            }
        })
        .collect();

    // Create parent directories (sequential to avoid races)
    for (_, local_path, _) in &to_download {
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
    }

    // Download in parallel
    let results: Vec<Result<()>> = stream::iter(to_download)
        .map(|(key, local_path, last_modified)| {
            let client = client.clone();
            let bucket = bucket.to_string();
            async move {
                info!(
                    "Downloading s3://{bucket}/{key} -> {}",
                    local_path.display()
                );
                let resp = client
                    .get_object()
                    .bucket(&bucket)
                    .key(&key)
                    .send()
                    .await
                    .with_context(|| format!("Failed to get s3://{bucket}/{key}"))?;
                let data = resp.body.collect().await?.into_bytes();
                tokio::fs::write(&local_path, &data).await?;
                // Set mtime to match S3 object's last_modified so upload diff works correctly
                set_mtime(&local_path, &last_modified)?;
                Ok(())
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    for result in results {
        result?;
    }

    // Delete local files that don't exist in S3
    let remote_relatives: std::collections::HashSet<String> = remote_objects
        .keys()
        .map(|k| strip_prefix(k, prefix))
        .collect();

    for relative in local_files.keys() {
        if !remote_relatives.contains(relative) {
            let local_path = local_dir.join(relative);
            info!("Deleting local file not in S3: {}", local_path.display());
            if let Err(e) = tokio::fs::remove_file(&local_path).await {
                tracing::warn!("Failed to delete local file {}: {e}", local_path.display());
            }
        }
    }

    Ok(())
}

/// Upload local directory to S3, mirroring `aws s3 sync --delete`.
/// Compares size and last-modified time to determine which files need updating.
///
/// Pass glob pattern and metadata pairs in `metadata_rules`.
/// The metadata from the first rule matching each file's relative path is applied to `put_object`.
pub async fn upload(
    client: &Client,
    bucket: &str,
    prefix: Option<&str>,
    local_dir: &Path,
    concurrency: usize,
    metadata_rules: &[MetadataRule],
) -> Result<UploadResult> {
    // Compile glob patterns (once)
    let mut compiled: Vec<(Pattern, &ObjectMetadata)> = Vec::with_capacity(metadata_rules.len());
    for r in metadata_rules {
        let pat = Pattern::new(&r.pattern)
            .with_context(|| format!("invalid glob pattern {:?}", r.pattern))?;
        compiled.push((pat, &r.metadata));
    }

    let remote_objects = list_objects(client, bucket, prefix).await?;
    let local_files = list_local_files(local_dir)?;

    // Collect files to upload — pre-resolve cache_control to move into async closure
    let to_upload: Vec<_> = local_files
        .iter()
        .filter_map(|(relative, local)| {
            let key = make_key(relative, prefix);
            let should_upload = match remote_objects.get(&key) {
                None => true,
                Some(remote) => {
                    local.size as i64 != remote.size
                        || mtime_to_secs(local.modified) > remote.last_modified.secs()
                }
            };
            if should_upload {
                let (cache_control, content_type) = resolve_metadata(&compiled, relative);
                Some((key, local.path.clone(), cache_control, content_type))
            } else {
                None
            }
        })
        .collect();

    // Capture the keys we are about to upload so we can return them on success.
    let uploaded_keys: Vec<String> = to_upload.iter().map(|(k, _, _, _)| k.clone()).collect();

    // Upload in parallel
    let results: Vec<Result<()>> = stream::iter(to_upload)
        .map(|(key, local_path, cache_control, content_type)| {
            let client = client.clone();
            let bucket = bucket.to_string();
            async move {
                info!("Uploading {} -> s3://{bucket}/{key}", local_path.display());
                let data = tokio::fs::read(&local_path)
                    .await
                    .with_context(|| format!("Failed to read {}", local_path.display()))?;
                let body = ByteStream::from(data);
                let mut req = client.put_object().bucket(&bucket).key(&key).body(body);
                if let Some(cc) = cache_control {
                    req = req.cache_control(cc);
                }
                if let Some(ct) = content_type {
                    req = req.content_type(ct);
                }
                req.send()
                    .await
                    .with_context(|| format!("Failed to put s3://{bucket}/{key}"))?;
                Ok(())
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    for result in results {
        result?;
    }

    // Delete S3 objects that don't exist locally
    let local_keys: std::collections::HashSet<String> =
        local_files.keys().map(|r| make_key(r, prefix)).collect();

    let to_delete: Vec<String> = remote_objects
        .keys()
        .filter(|key| !local_keys.contains(*key))
        .cloned()
        .collect();

    let deleted_keys = to_delete.clone();

    let delete_results: Vec<Result<()>> = stream::iter(to_delete)
        .map(|key| {
            let client = client.clone();
            let bucket = bucket.to_string();
            async move {
                info!("Deleting S3 object not found locally: s3://{bucket}/{key}");
                client
                    .delete_object()
                    .bucket(&bucket)
                    .key(&key)
                    .send()
                    .await
                    .with_context(|| format!("Failed to delete s3://{bucket}/{key}"))?;
                Ok(())
            }
        })
        .buffer_unordered(concurrency)
        .collect()
        .await;

    for result in delete_results {
        result?;
    }

    Ok(UploadResult {
        uploaded: uploaded_keys,
        deleted: deleted_keys,
    })
}

/// Set a file's mtime to match an S3 object's last_modified timestamp.
fn set_mtime(path: &Path, last_modified: &DateTime) -> Result<()> {
    use filetime::FileTime;
    let mtime = FileTime::from_unix_time(last_modified.secs(), last_modified.subsec_nanos());
    filetime::set_file_mtime(path, mtime)
        .with_context(|| format!("Failed to set mtime on {}", path.display()))
}

fn mtime_to_secs(t: SystemTime) -> i64 {
    t.duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// List all objects in an S3 bucket under a given prefix.
/// Returns a map of key -> ObjectMeta (size, last_modified).
async fn list_objects(
    client: &Client,
    bucket: &str,
    prefix: Option<&str>,
) -> Result<HashMap<String, ObjectMeta>> {
    let mut objects = HashMap::new();
    let mut continuation_token: Option<String> = None;

    loop {
        let mut req = client.list_objects_v2().bucket(bucket);

        if let Some(p) = prefix {
            req = req.prefix(format!("{p}/"));
        }

        if let Some(token) = &continuation_token {
            req = req.continuation_token(token);
        }

        let resp = req.send().await.context("Failed to list S3 objects")?;

        for obj in resp.contents() {
            if let (Some(key), Some(size), Some(last_modified)) =
                (obj.key(), obj.size(), obj.last_modified())
            {
                objects.insert(
                    key.to_string(),
                    ObjectMeta {
                        size,
                        last_modified: *last_modified,
                    },
                );
            }
        }

        if resp.is_truncated() == Some(true) {
            continuation_token = resp.next_continuation_token().map(|s| s.to_string());
        } else {
            break;
        }
    }

    Ok(objects)
}

/// List all files in a local directory recursively.
/// Returns a map of relative path (using forward slashes) -> FileMeta.
fn list_local_files(dir: &Path) -> Result<HashMap<String, FileMeta>> {
    let mut files = HashMap::new();

    if !dir.exists() {
        return Ok(files);
    }

    fn walk(dir: &Path, base: &Path, files: &mut HashMap<String, FileMeta>) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, files)?;
            } else {
                let metadata = std::fs::metadata(&path)?;
                let relative = path
                    .strip_prefix(base)?
                    .to_string_lossy()
                    .replace('\\', "/");
                files.insert(
                    relative,
                    FileMeta {
                        path,
                        size: metadata.len(),
                        modified: metadata.modified()?,
                    },
                );
            }
        }
        Ok(())
    }

    walk(dir, dir, &mut files)?;
    Ok(files)
}

/// Strip the S3 prefix from a key to get the relative path.
fn strip_prefix(key: &str, prefix: Option<&str>) -> String {
    match prefix {
        Some(p) => {
            let full_prefix = format!("{p}/");
            key.strip_prefix(&full_prefix).unwrap_or(key).to_string()
        }
        None => key.to_string(),
    }
}

/// Construct an S3 key from a relative path and optional prefix.
fn make_key(relative: &str, prefix: Option<&str>) -> String {
    match prefix {
        Some(p) => format!("{p}/{relative}"),
        None => relative.to_string(),
    }
}
