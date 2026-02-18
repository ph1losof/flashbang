use super::Bang;
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize)]
struct CustomFile {
    bangs: HashMap<String, CustomBang>,
}

#[derive(Deserialize)]
struct CustomBang {
    name: String,
    url: String,
    domain: String,
}

pub fn parse(raw: &str) -> Vec<Bang> {
    let file: CustomFile = toml::from_str(raw).expect("Failed to parse custom TOML");

    file.bangs
        .into_iter()
        .map(|(trigger, b)| Bang {
            trigger: trigger.to_lowercase(),
            name: b.name,
            domain: b.domain,
            url: b.url,
        })
        .collect()
}
