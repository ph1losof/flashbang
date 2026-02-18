use crate::sources::Bang;
use std::path::Path;

fn js_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(c),
        }
    }
    out
}

fn generate_min(bangs: &[Bang], out_dir: &Path) {
    let mut js = String::from("export const BANGS={");

    for (i, bang) in bangs.iter().enumerate() {
        if i > 0 {
            js.push(',');
        }
        js.push('\'');
        js.push_str(&js_escape(&bang.trigger));
        js.push_str("':'");
        js.push_str(&js_escape(&bang.url));
        js.push('\'');
    }

    js.push_str("};");

    let path = out_dir.join("bangs-min.js");
    std::fs::write(&path, &js).expect("Failed to write bangs-min.js");
    println!("  bangs-min.js: {} bytes", js.len());
}

fn generate_full(bangs: &[Bang], out_dir: &Path) {
    let mut js = String::from("export const BANGS={");

    for (i, bang) in bangs.iter().enumerate() {
        if i > 0 {
            js.push(',');
        }
        js.push('\'');
        js.push_str(&js_escape(&bang.trigger));
        js.push_str("':{s:'");
        js.push_str(&js_escape(&bang.name));
        js.push_str("',d:'");
        js.push_str(&js_escape(&bang.domain));
        js.push_str("',u:'");
        js.push_str(&js_escape(&bang.url));
        js.push_str("'}");
    }

    js.push_str("};");

    let path = out_dir.join("bangs-full.js");
    std::fs::write(&path, &js).expect("Failed to write bangs-full.js");
    println!("  bangs-full.js: {} bytes", js.len());
}

fn generate_meta(bangs: &[Bang], out_dir: &Path) {
    let meta = format!(
        r#"{{"count":{},"generated":"{}"}}"#,
        bangs.len(),
        chrono_free_now()
    );

    let path = out_dir.join("bangs-meta.json");
    std::fs::write(&path, &meta).expect("Failed to write bangs-meta.json");
}

fn chrono_free_now() -> String {
    let output = std::process::Command::new("date")
        .arg("-u")
        .arg("+%Y-%m-%dT%H:%M:%SZ")
        .output();

    match output {
        Ok(o) => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        Err(_) => "unknown".to_string(),
    }
}

pub fn generate(bangs: &[Bang], out_dir: &Path) {
    generate_min(bangs, out_dir);
    generate_full(bangs, out_dir);
    generate_meta(bangs, out_dir);
}
