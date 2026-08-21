mod capabilities;
mod contract;
mod messages;
mod payload;
mod provider;
mod retry;
mod speaker;
mod stream;
mod usage;

pub use provider::OpenAiCompatibleProvider;

#[cfg(test)]
mod tests;
