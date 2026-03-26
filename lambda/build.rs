use std::fs;
use std::path::Path;

use pulldown_cmark::{Options, Parser, html};

fn main() {
    let readme_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("README.md");
    println!("cargo::rerun-if-changed={}", readme_path.display());

    let markdown = fs::read_to_string(&readme_path).expect("Failed to read README.md");

    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    let parser = Parser::new_ext(&markdown, options);
    let mut body_html = String::new();
    html::push_html(&mut body_html, parser);

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>apt-awscli-v2</title>
<style>
body {{
    max-width: 48rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #24292f;
}}
pre {{
    background: #f6f8fa;
    padding: 1rem;
    border-radius: 6px;
    overflow-x: auto;
}}
code {{
    background: #f6f8fa;
    padding: 0.2em 0.4em;
    border-radius: 3px;
    font-size: 0.9em;
}}
pre code {{
    background: none;
    padding: 0;
}}
a {{
    color: #0969da;
}}
</style>
</head>
<body>
{body_html}
</body>
</html>
"#
    );

    let out_dir = std::env::var("OUT_DIR").unwrap();
    let out_path = Path::new(&out_dir).join("index.html");
    fs::write(&out_path, &html).expect("Failed to write index.html");

    // Also copy to target/index.html for easy preview
    let preview_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("index.html");
    fs::write(&preview_path, &html).expect("Failed to write preview index.html");
}
