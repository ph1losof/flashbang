use crate::sources::Bang;
use std::collections::HashMap;

pub fn merge(sources: Vec<(&str, Vec<Bang>)>) -> Vec<Bang> {
    let mut map: HashMap<String, Bang> = HashMap::new();

    for (_source_name, bangs) in sources {
        for bang in bangs {
            if let Some(existing) = map.get(&bang.trigger) {
                let relevance = existing.relevance.max(bang.relevance);
                let mut new_bang = bang;
                new_bang.relevance = relevance;
                map.insert(new_bang.trigger.clone(), new_bang);
            } else {
                map.insert(bang.trigger.clone(), bang);
            }
        }
    }

    let mut result: Vec<Bang> = map.into_values().collect();
    result.sort_by(|a, b| a.trigger.cmp(&b.trigger));
    result
}
