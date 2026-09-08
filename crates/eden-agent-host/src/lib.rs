//! Product host tools backed by the Rust store and fixed outbound clients.

mod core;
mod desktop_reminder;
mod contact_delivery;
pub use contact_delivery::{deliver_user_contact, deliver_user_contact_tracked};
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
