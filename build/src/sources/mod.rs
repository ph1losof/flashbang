pub mod custom;
pub mod ddg;
pub mod kagi;

pub struct Bang {
    pub trigger: String,
    pub name: String,
    pub domain: String,
    pub url: String,
    pub relevance: u32,
}
