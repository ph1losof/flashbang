use crate::sources::Bang;

pub fn validate(bangs: Vec<Bang>) -> Vec<Bang> {
    bangs
        .into_iter()
        .filter(|b| {
            if b.trigger.is_empty() {
                return false;
            }
            if !b.url.contains("{}") {
                eprintln!(
                    "Warning: bang !{} has no {{}} placeholder in URL",
                    b.trigger
                );
            }
            true
        })
        .collect()
}
