use crate::sources::Bang;
use std::collections::HashMap;

pub fn merge(sources: Vec<(&str, Vec<Bang>)>) -> Vec<Bang> {
    let mut map: HashMap<String, Bang> = HashMap::new();

    for (_source_name, bangs) in sources {
        for bang in bangs {
            map.insert(bang.trigger.clone(), bang);
        }
    }

    let mut result: Vec<Bang> = map.into_values().collect();
    result.sort_by(|a, b| a.trigger.cmp(&b.trigger));
    result
}
