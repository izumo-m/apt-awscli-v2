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
    let html = fetch_tags_html("https://github.com/aws/aws-cli/tags").await?;
    parse_latest_version(&html)
}

/// Parse the GitHub tags HTML and return the latest AWS CLI v2 version.
fn parse_latest_version(html: &str) -> Result<(String, DateTime<Utc>)> {
    let tag_re = Regex::new(r"/aws/aws-cli/releases/tag/([\w.+\-]+)")?;
    let v2_re = Regex::new(r"^2\.\d+\.\d+$")?;
    parse_github_tags(html, &tag_re, &v2_re, "No AWS CLI v2 version found")
}

/// Fetch the latest Session Manager Plugin version from GitHub tags.
/// Returns the version string and the release datetime.
///
/// See [`fetch_latest_version`] for why we scrape HTML instead of using the API.
pub async fn fetch_session_manager_plugin_version() -> Result<(String, DateTime<Utc>)> {
    let html = fetch_tags_html("https://github.com/aws/session-manager-plugin/tags").await?;
    parse_session_manager_plugin_version(&html)
}

/// Parse the GitHub tags HTML and return the latest Session Manager Plugin version.
fn parse_session_manager_plugin_version(html: &str) -> Result<(String, DateTime<Utc>)> {
    let tag_re = Regex::new(r"/aws/session-manager-plugin/releases/tag/([\w.+\-]+)")?;
    let smp_re = Regex::new(r"^\d+\.\d+\.\d+\.\d+$")?;
    parse_github_tags(
        html,
        &tag_re,
        &smp_re,
        "No Session Manager Plugin version found",
    )
}

/// GET a GitHub tags page and return its body, surfacing non-success HTTP
/// statuses explicitly so we never silently parse an error page as empty HTML.
async fn fetch_tags_html(url: &str) -> Result<String> {
    let resp = reqwest::get(url)
        .await
        .with_context(|| format!("Failed to fetch {url}"))?;
    let status = resp.status();
    if !status.is_success() {
        anyhow::bail!("Failed to fetch {url}: HTTP {status}");
    }
    resp.text()
        .await
        .with_context(|| format!("Failed to read response body from {url}"))
}

/// Scan a GitHub tags HTML page and return the first (latest) version with its release datetime.
///
/// `tag_re` is a permissive regex that captures every release-tag URL in the page (e.g. both
/// `2.x.y` and `1.x.y` entries on the AWS CLI tags page). `version_filter` then decides which
/// captured tags qualify.
///
/// We collect every tag and every `datetime="..."` attribute, sort by their byte positions to
/// reconstruct document order, and walk them as a stream:
///   - A tag that passes `version_filter` becomes the current candidate.
///   - A tag that fails the filter clears the candidate — this is what prevents a neighbouring
///     1.x entry's datetime from being misattributed to a 2.x tag we just saw.
///   - The first datetime encountered while a candidate is set is returned with that candidate.
fn parse_github_tags(
    html: &str,
    tag_re: &Regex,
    version_filter: &Regex,
    not_found_msg: &str,
) -> Result<(String, DateTime<Utc>)> {
    let datetime_re = Regex::new(r#"datetime="([^"]+)""#)?;

    let mut entries: Vec<(usize, Token)> = Vec::new();

    for cap in tag_re.captures_iter(html) {
        let m = cap.get(1).unwrap();
        entries.push((m.start(), Token::Version(m.as_str().to_string())));
    }
    for cap in datetime_re.captures_iter(html) {
        let m = cap.get(1).unwrap();
        entries.push((m.start(), Token::Datetime(m.as_str().to_string())));
    }

    entries.sort_by_key(|(pos, _)| *pos);

    let mut current_tag: Option<String> = None;

    for (_, token) in entries {
        match token {
            Token::Version(v) => {
                if version_filter.is_match(&v) {
                    current_tag = Some(v);
                } else {
                    current_tag = None;
                }
            }
            Token::Datetime(dt) => {
                if let Some(tag) = current_tag.take() {
                    let released_at = dt
                        .parse::<DateTime<Utc>>()
                        .with_context(|| format!("Failed to parse datetime: {dt}"))?;
                    return Ok((tag, released_at));
                }
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
    fn only_1x_in_html_returns_err() {
        // A page containing only 1.x tags should not yield any 2.x result.
        let now = Utc::now();
        let html = awscli_html(&[("1.44.39", now - Duration::hours(72))]);
        let result = parse_latest_version(&html);
        assert!(result.is_err(), "Should not return 1.x version");
    }

    #[test]
    fn intervening_1x_tag_clears_2x_candidate() {
        // Hypothetical layout where a 1.x tag sits between a 2.x tag and the
        // next datetime. Without the "clear on non-matching tag" rule, that
        // datetime would be misattributed to 2.x.
        let now = Utc::now();
        let html = format!(
            "<html><body>\n\
             <a href=\"/aws/aws-cli/releases/tag/2.33.22\">2.33.22</a>\n\
             <a href=\"/aws/aws-cli/releases/tag/1.44.39\">1.44.39</a>\n\
             <relative-time datetime=\"{}\">x</relative-time>\n\
             </body></html>",
            fmt(now - Duration::hours(48))
        );
        assert!(parse_latest_version(&html).is_err());
    }

    #[test]
    fn pre_release_2x_tag_is_skipped() {
        // A 2.x.y-pre tag must not be returned as a stable 2.x.y version.
        let now = Utc::now();
        let html = awscli_html(&[
            ("2.99.0-pre", now - Duration::hours(1)),
            ("2.33.21", now - Duration::hours(48)),
        ]);
        let (ver, _) = parse_latest_version(&html).unwrap();
        assert_eq!(ver, "2.33.21");
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
