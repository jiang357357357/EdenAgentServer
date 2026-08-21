//! Product host tools backed by the Rust store and fixed outbound clients.

mod core;
mod core_tools;
mod host;
mod support;
mod tools;
mod web;

pub use host::HostServices;

pub(crate) use core::CoreClient;
pub(crate) use support::output;

#[cfg(test)]
mod tests;
