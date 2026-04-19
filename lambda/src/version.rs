use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use regex::Regex;

/// Fetch the latest AWS CLI v2 version from GitHub tags.
/// Returns the version string and the release datetime.
///
/// We scrape the GitHub tags HTML page instead of using the GitHub API because
/// the HTML contains both the tag name and the release datetime in a single page,
/// whereas the API would require multiple requests (tags + commits) to get the same
/// information.
pub async fn fetch_latest_version() -> Result<(String, DateTime<Utc>)> {
    let html = reqwest::get("https://github.com/aws/aws-cli/tags")
        .await
        .context("Failed to fetch GitHub tags page")?
        .text()
        .await
        .context("Failed to read GitHub tags response body")?;

    parse_latest_version(&html)
}

/// Parse the GitHub tags HTML and return the latest AWS CLI v2 version.
fn parse_latest_version(html: &str) -> Result<(String, DateTime<Utc>)> {
    let version_re = Regex::new(r"/aws/aws-cli/releases/tag/(2\.\d+\.\d+)")?;
    parse_github_tags(html, &version_re, "No AWS CLI v2 version found")
}

/// Fetch the latest Session Manager Plugin version from GitHub tags.
/// Returns the version string and the release datetime.
///
/// See [`fetch_latest_version`] for why we scrape HTML instead of using the API.
pub async fn fetch_session_manager_plugin_version() -> Result<(String, DateTime<Utc>)> {
    let html = reqwest::get("https://github.com/aws/session-manager-plugin/tags")
        .await
        .context("Failed to fetch Session Manager Plugin GitHub tags page")?
        .text()
        .await
        .context("Failed to read Session Manager Plugin GitHub tags response body")?;

    parse_session_manager_plugin_version(&html)
}

/// Parse the GitHub tags HTML and return the latest Session Manager Plugin version.
fn parse_session_manager_plugin_version(html: &str) -> Result<(String, DateTime<Utc>)> {
    let version_re = Regex::new(r"/aws/session-manager-plugin/releases/tag/(\d+\.\d+\.\d+\.\d+)")?;
    parse_github_tags(html, &version_re, "No Session Manager Plugin version found")
}

/// Scan a GitHub tags HTML page and return the first (latest) version with its release datetime.
///
/// Matches version tags and `datetime` attributes in document order.
/// When a version token is followed immediately by a datetime,
/// that (version, datetime) pair is returned. A datetime that belongs to a different
/// version (e.g. a 1.x entry interleaved with 2.x) resets the current candidate.
fn parse_github_tags(
    html: &str,
    version_re: &Regex,
    not_found_msg: &str,
) -> Result<(String, DateTime<Utc>)> {
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

    // Walk tokens: remember the most recent version tag; when we see a datetime,
    // return the remembered version.
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
                    let released_at = dt
                        .parse::<DateTime<Utc>>()
                        .with_context(|| format!("Failed to parse datetime: {dt}"))?;
                    return Ok((tag.clone(), released_at));
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
    use chrono::Duration;

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
    fn returns_latest_v2() {
        let now = Utc::now();
        let html = awscli_html(&[
            ("2.33.22", now - Duration::hours(1)),
            ("2.33.21", now - Duration::hours(48)),
        ]);
        let (ver, rel) = parse_latest_version(&html).unwrap();
        assert_eq!(ver, "2.33.22");
        assert_eq!(fmt(rel), fmt(now - Duration::hours(1)));
    }

    #[test]
    fn skips_1x_versions() {
        let now = Utc::now();
        let html = awscli_html(&[
            ("1.44.39", now - Duration::hours(48)),
            ("2.33.21", now - Duration::hours(48)),
        ]);
        let (ver, _) = parse_latest_version(&html).unwrap();
        assert_eq!(ver, "2.33.21");
    }

    #[test]
    fn interleaved_1x_and_2x() {
        let now = Utc::now();
        let html = awscli_html(&[
            ("2.33.22", now - Duration::hours(1)),
            ("1.44.39", now - Duration::hours(1)),
            ("2.33.21", now - Duration::hours(24)),
            ("1.44.38", now - Duration::hours(24)),
        ]);
        let (ver, rel) = parse_latest_version(&html).unwrap();
        assert_eq!(ver, "2.33.22");
        assert_eq!(fmt(rel), fmt(now - Duration::hours(1)));
    }

    #[test]
    fn v1x_datetime_not_attributed_to_v2x() {
        // 2.x tag followed by 1.x datetime: the datetime belongs to 1.x,
        // so 2.x should not pick it up. But 2.x has no datetime of its own,
        // so only 1.x's datetime resets the candidate.
        let now = Utc::now();
        let html = awscli_html(&[("1.44.39", now - Duration::hours(72))]);
        let result = parse_latest_version(&html);
        assert!(result.is_err(), "Should not return 1.x version");
    }

    #[test]
    fn no_2x_versions() {
        let now = Utc::now();
        let html = awscli_html(&[
            ("1.44.39", now - Duration::hours(48)),
            ("1.44.38", now - Duration::hours(72)),
        ]);
        assert!(parse_latest_version(&html).is_err());
    }

    #[test]
    fn empty_html() {
        assert!(parse_latest_version("<html></html>").is_err());
    }

    // --- Session Manager Plugin tests ---

    fn smp_html(entries: &[(&str, DateTime<Utc>)]) -> String {
        make_tags_html("aws/session-manager-plugin", entries)
    }

    #[test]
    fn smp_returns_latest() {
        let now = Utc::now();
        let html = smp_html(&[
            ("1.2.708.0", now - Duration::hours(1)),
            ("1.2.707.0", now - Duration::hours(24)),
        ]);
        let (ver, rel) = parse_session_manager_plugin_version(&html).unwrap();
        assert_eq!(ver, "1.2.708.0");
        assert_eq!(fmt(rel), fmt(now - Duration::hours(1)));
    }

    #[test]
    fn smp_empty_html() {
        assert!(parse_session_manager_plugin_version("<html></html>").is_err());
    }
}
