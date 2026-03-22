use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use regex::Regex;

/// Fetch the latest AWS CLI v2 version from GitHub tags.
/// Only returns versions that are at least 1 day old.
/// Returns the version string and the release datetime.
pub async fn fetch_latest_version() -> Result<(String, DateTime<Utc>)> {
    let threshold = Utc::now() - Duration::hours(24);

    let html = reqwest::get("https://github.com/aws/aws-cli/tags")
        .await
        .context("Failed to fetch GitHub tags page")?
        .text()
        .await
        .context("Failed to read GitHub tags response body")?;

    parse_latest_version(&html, threshold)
}

/// Parse the GitHub tags HTML and return the latest AWS CLI v2 version
/// whose release datetime is older than `threshold`.
fn parse_latest_version(html: &str, threshold: DateTime<Utc>) -> Result<(String, DateTime<Utc>)> {
    let version_re = Regex::new(r"/aws/aws-cli/releases/tag/(2\.\d+\.\d+)")?;
    parse_github_tags(html, threshold, &version_re, "No AWS CLI v2 version found that is at least 1 day old")
}

/// Fetch the latest Session Manager Plugin version from GitHub tags.
/// Only returns versions that are at least 1 day old.
/// Returns the version string and the release datetime.
pub async fn fetch_session_manager_plugin_version() -> Result<(String, DateTime<Utc>)> {
    let threshold = Utc::now() - Duration::hours(24);

    let html = reqwest::get("https://github.com/aws/session-manager-plugin/tags")
        .await
        .context("Failed to fetch Session Manager Plugin GitHub tags page")?
        .text()
        .await
        .context("Failed to read Session Manager Plugin GitHub tags response body")?;

    parse_session_manager_plugin_version(&html, threshold)
}

/// Parse the GitHub tags HTML and return the latest Session Manager Plugin version
/// whose release datetime is older than `threshold`.
fn parse_session_manager_plugin_version(html: &str, threshold: DateTime<Utc>) -> Result<(String, DateTime<Utc>)> {
    let version_re = Regex::new(r"/aws/session-manager-plugin/releases/tag/(\d+\.\d+\.\d+\.\d+)")?;
    parse_github_tags(html, threshold, &version_re, "No Session Manager Plugin version found that is at least 1 day old")
}

/// Scan a GitHub tags HTML page and return the first version whose release datetime
/// is older than `threshold`.
///
/// Matches version tags and `datetime` attributes in document order.
/// When a version token is followed immediately by a datetime older than the threshold,
/// that (version, datetime) pair is returned. A datetime that belongs to a different
/// version (e.g. a 1.x entry interleaved with 2.x) resets the current candidate.
fn parse_github_tags(
    html: &str,
    threshold: DateTime<Utc>,
    version_re: &Regex,
    not_found_msg: &str,
) -> Result<(String, DateTime<Utc>)> {
    let threshold_str = threshold.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let datetime_re = Regex::new(r#"datetime="([^"]+)""#)?;

    // Collect version and datetime tokens with their byte positions, then sort by position
    // to reconstruct document order regardless of which regex matched first.
    let mut entries: Vec<(usize, Token)> = Vec::new();

    for cap in version_re.captures_iter(html) {
        let m = cap.get(1).unwrap();
        entries.push((m.start(), Token::Version(m.as_str().to_string())));
    }
    for cap in datetime_re.captures_iter(html) {
        let m = cap.get(1).unwrap();
        entries.push((m.start(), Token::Datetime(m.as_str().to_string())));
    }

    entries.sort_by_key(|(pos, _)| *pos);

    // Walk tokens: remember the most recent version tag; when we see a datetime
    // older than the threshold, return the remembered version.
    // A datetime that does not follow a version (i.e. belongs to another tag) clears
    // the candidate so we don't misattribute it.
    let mut current_tag: Option<String> = None;

    for (_, token) in entries {
        match token {
            Token::Version(v) => {
                current_tag = Some(v);
            }
            Token::Datetime(dt) => {
                if let Some(ref tag) = current_tag {
                    if dt.as_str() < threshold_str.as_str() {
                        let released_at = dt
                            .parse::<DateTime<Utc>>()
                            .with_context(|| format!("Failed to parse datetime: {dt}"))?;
                        return Ok((tag.clone(), released_at));
                    }
                }
                current_tag = None;
            }
        }
    }

    anyhow::bail!("{}", not_found_msg)
}

enum Token {
    Version(String),
    Datetime(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// threshold from now (= 1 day ago)
    fn now_threshold() -> DateTime<Utc> {
        Utc::now() - Duration::hours(24)
    }

    /// Format a DateTime as the ISO 8601 string used in GitHub's HTML.
    fn fmt(dt: DateTime<Utc>) -> String {
        dt.format("%Y-%m-%dT%H:%M:%SZ").to_string()
    }

    /// Generate a minimal GitHub-like tags HTML snippet for the given repository path.
    /// Each entry is a (version, release_datetime) pair.
    fn make_tags_html(repo: &str, entries: &[(&str, DateTime<Utc>)]) -> String {
        let mut html = String::from("<html><body>\n");
        for (version, datetime) in entries {
            let dt_str = fmt(*datetime);
            html.push_str(&format!(
                "<h2><a href=\"/{repo}/releases/tag/{version}\">{version}</a></h2>\n\
                 <relative-time datetime=\"{dt_str}\">some date</relative-time>\n"
            ));
        }
        html.push_str("</body></html>");
        html
    }

    // --- AWS CLI tests ---

    fn awscli_html(entries: &[(&str, DateTime<Utc>)]) -> String {
        make_tags_html("aws/aws-cli", entries)
    }

    #[test]
    fn returns_first_old_enough_v2() {
        let th = now_threshold();
        let html = awscli_html(&[
            ("2.33.22", th + Duration::hours(1)),  // too recent
            ("2.33.21", th - Duration::hours(24)), // old enough
        ]);
        let (ver, rel) = parse_latest_version(&html, th).unwrap();
        assert_eq!(ver, "2.33.21");
        assert_eq!(fmt(rel), fmt(th - Duration::hours(24)));
    }

    #[test]
    fn first_entry_already_old_enough() {
        let th = now_threshold();
        let html = awscli_html(&[
            ("2.33.22", th - Duration::hours(48)),
            ("2.33.21", th - Duration::hours(72)),
        ]);
        let (ver, _) = parse_latest_version(&html, th).unwrap();
        assert_eq!(ver, "2.33.22");
    }

    #[test]
    fn skips_1x_versions() {
        let th = now_threshold();
        let html = awscli_html(&[
            ("1.44.39", th - Duration::hours(48)),
            ("2.33.21", th - Duration::hours(48)),
        ]);
        let (ver, _) = parse_latest_version(&html, th).unwrap();
        assert_eq!(ver, "2.33.21");
    }

    #[test]
    fn interleaved_1x_and_2x() {
        // Real GitHub layout: 2.x and 1.x alternate
        let th = now_threshold();
        let html = awscli_html(&[
            ("2.33.22", th + Duration::hours(1)),  // too recent
            ("1.44.39", th + Duration::hours(1)),  // 1.x, skip
            ("2.33.21", th - Duration::hours(24)), // old enough
            ("1.44.38", th - Duration::hours(24)), // 1.x, skip
        ]);
        let (ver, rel) = parse_latest_version(&html, th).unwrap();
        assert_eq!(ver, "2.33.21");
        assert_eq!(fmt(rel), fmt(th - Duration::hours(24)));
    }

    #[test]
    fn v1x_old_datetime_not_attributed_to_v2x() {
        // 2.x is too recent, followed by 1.x with an old datetime.
        // Must NOT return 2.x with 1.x's datetime.
        let th = now_threshold();
        let html = awscli_html(&[
            ("2.33.22", th + Duration::hours(1)),  // too recent
            ("1.44.39", th - Duration::hours(72)), // 1.x with old date
        ]);
        let result = parse_latest_version(&html, th);
        assert!(result.is_err(), "Should not return 2.33.22 with 1.x's datetime");
    }

    #[test]
    fn all_too_recent() {
        let th = now_threshold();
        let html = awscli_html(&[
            ("2.33.22", th + Duration::hours(2)),
            ("2.33.21", th + Duration::hours(1)),
        ]);
        assert!(parse_latest_version(&html, th).is_err());
    }

    #[test]
    fn no_2x_versions() {
        let th = now_threshold();
        let html = awscli_html(&[
            ("1.44.39", th - Duration::hours(48)),
            ("1.44.38", th - Duration::hours(72)),
        ]);
        assert!(parse_latest_version(&html, th).is_err());
    }

    #[test]
    fn empty_html() {
        assert!(parse_latest_version("<html></html>", now_threshold()).is_err());
    }

    // --- Session Manager Plugin tests ---

    fn smp_html(entries: &[(&str, DateTime<Utc>)]) -> String {
        make_tags_html("aws/session-manager-plugin", entries)
    }

    #[test]
    fn smp_returns_first_old_enough() {
        let th = now_threshold();
        let html = smp_html(&[
            ("1.2.708.0", th + Duration::hours(1)),  // too recent
            ("1.2.707.0", th - Duration::hours(24)), // old enough
        ]);
        let (ver, rel) = parse_session_manager_plugin_version(&html, th).unwrap();
        assert_eq!(ver, "1.2.707.0");
        assert_eq!(fmt(rel), fmt(th - Duration::hours(24)));
    }

    #[test]
    fn smp_all_too_recent() {
        let th = now_threshold();
        let html = smp_html(&[
            ("1.2.708.0", th + Duration::hours(2)),
            ("1.2.707.0", th + Duration::hours(1)),
        ]);
        assert!(parse_session_manager_plugin_version(&html, th).is_err());
    }

    #[test]
    fn smp_empty_html() {
        assert!(parse_session_manager_plugin_version("<html></html>", now_threshold()).is_err());
    }
}
