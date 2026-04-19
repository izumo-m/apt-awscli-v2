mod logging;

use std::path::Path;

use anyhow::Result;
use apt_awscli_v2_lambda::{builder, config, deploy, s3_sync, smp_builder, version};
use chrono::Utc;
use config::Package;
use lambda_runtime::{service_fn, Error, LambdaEvent, Runtime};
use tracing::{info, Instrument};

#[tokio::main]
async fn main() -> Result<(), Error> {
    logging::init();

    let runtime = Runtime::new(service_fn(handler));
    runtime.run().await?;
    Ok(())
}

async fn handler(event: LambdaEvent<serde_json::Value>) -> Result<serde_json::Value, Error> {
    let id = &event.context.request_id;
    let short_id = &id[..id.len().min(8)];
    let span = tracing::info_span!("", req = short_id);
    handler_inner(event).instrument(span).await
}

async fn handler_inner(event: LambdaEvent<serde_json::Value>) -> Result<serde_json::Value, Error> {
    info!("Lambda handler started");

    let force_deploy = event
        .payload
        .get("deploy_only")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let fail_for_test = event
        .payload
        .get("fail_for_test")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if fail_for_test {
        return Err(anyhow::anyhow!(
            "intentional failure for notification test (fail_for_test=true)"
        )
        .into());
    }

    // 1. Load config
    let config = config::Config::from_env()?;
    info!(
        "Config: archs={:?}, bucket={}, prefix={:?}, packages={:?}",
        config.archs,
        config.s3_bucket,
        config.s3_prefix,
        config
            .packages
            .iter()
            .map(|p| p.file_prefix())
            .collect::<Vec<_>>(),
    );

    // 2. Set up AWS SDK clients
    let aws_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
    let s3_config = aws_sdk_s3::config::Builder::from(&aws_config)
        .stalled_stream_protection(aws_sdk_s3::config::StalledStreamProtectionConfig::disabled())
        .build();
    let s3_client = aws_sdk_s3::Client::from_conf(s3_config);
    let ssm_client = aws_sdk_ssm::Client::new(&aws_config);

    // 3. Sync S3 -> local repo
    let repo_dir = config.repo_dir();
    std::fs::create_dir_all(&repo_dir)?;

    if force_deploy {
        // deploy_only: sync, regenerate indexes for all packages, sign, and sync back
        info!("deploy_only=true, syncing S3 -> {repo_dir}...");
        s3_sync::download(
            &s3_client,
            &config.s3_bucket,
            config.s3_prefix.as_deref(),
            Path::new(&repo_dir),
            config.threads,
        )
        .await?;

        let release_date = Utc::now();
        let packages_with_dates: Vec<(Package, String, _)> = config
            .packages
            .iter()
            .map(|p| (p.clone(), String::new(), release_date))
            .collect();

        deploy::deploy_all(&config, &s3_client, &ssm_client, &packages_with_dates).await?;

        return Ok(serde_json::json!({
            "status": "ok",
            "deploy_only": true,
        }));
    }

    // 4. Sync S3 -> local  &  fetch all package versions in parallel
    info!("Syncing S3 -> {repo_dir} and fetching latest versions in parallel...");

    let has_awscli = config.packages.contains(&Package::AwsCli);
    let has_smp = config.packages.contains(&Package::SessionManagerPlugin);

    let (sync_result, awscli_result, smp_result) = tokio::join!(
        s3_sync::download(
            &s3_client,
            &config.s3_bucket,
            config.s3_prefix.as_deref(),
            Path::new(&repo_dir),
            config.threads,
        ),
        async {
            if has_awscli {
                Some(version::fetch_latest_version().await)
            } else {
                None
            }
        },
        async {
            if has_smp {
                Some(version::fetch_session_manager_plugin_version().await)
            } else {
                None
            }
        },
    );
    sync_result?;

    // 5. Build debs for each package × arch if needed
    let mut any_built = false;
    let mut packages_with_dates: Vec<(Package, String, chrono::DateTime<Utc>)> = Vec::new();

    if let Some(result) = awscli_result {
        let (latest_version, released_at) = result?;
        info!("AWS CLI latest version: {latest_version}, released at: {released_at}");

        for arch in &config.archs {
            let built = builder::build(&config, &latest_version, arch).await?;
            if built {
                any_built = true;
            }
        }
        packages_with_dates.push((Package::AwsCli, latest_version, released_at));
    }

    if let Some(result) = smp_result {
        let (latest_version, released_at) = result?;
        info!(
            "Session Manager Plugin latest version: {latest_version}, released at: {released_at}"
        );

        for arch in &config.archs {
            let built = smp_builder::build(&config, &latest_version, arch).await?;
            if built {
                any_built = true;
            }
        }
        packages_with_dates.push((Package::SessionManagerPlugin, latest_version, released_at));
    }

    if any_built {
        // 6. Deploy: prune, regenerate indexes, sign, sync to S3
        info!("New version(s) built, deploying...");
        deploy::deploy_all(&config, &s3_client, &ssm_client, &packages_with_dates).await?;
    } else {
        info!("No new versions to deploy.");
    }

    let versions: serde_json::Value = {
        let mut map = serde_json::Map::new();
        for (pkg, version, _) in &packages_with_dates {
            map.insert(pkg.file_prefix().to_string(), serde_json::json!(version));
        }
        serde_json::Value::Object(map)
    };

    Ok(serde_json::json!({
        "status": "ok",
        "built": any_built,
        "packages": versions,
    }))
}
