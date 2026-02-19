use super::Bang;
use serde::Deserialize;

#[derive(Deserialize)]
struct RawDdg {
    t: String,
    u: String,
    s: String,
    d: String,
    #[serde(default)]
    ts: Vec<String>,
    #[serde(default)]
    r: u32,
}

pub fn parse(raw: &str) -> Vec<Bang> {
    let entries: Vec<RawDdg> = serde_json::from_str(raw).expect("Failed to parse DDG JSON");
    let mut bangs = Vec::new();

    for entry in entries {
        let url = normalize_url(&entry.u);

        bangs.push(Bang {
            trigger: entry.t.to_lowercase(),
            name: entry.s.clone(),
            domain: entry.d.clone(),
            url: url.clone(),
            relevance: entry.r,
        });

        for alias in &entry.ts {
            bangs.push(Bang {
                trigger: alias.to_lowercase(),
                name: entry.s.clone(),
                domain: entry.d.clone(),
                url: url.clone(),
                relevance: entry.r,
            });
        }
    }

    bangs
}

fn normalize_url(u: &str) -> String {
    u.replace("{{{s}}}", "{}")
}
