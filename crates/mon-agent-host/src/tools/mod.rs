pub(crate) mod environment;
mod memo;
mod memory;
mod self_awake;

use crate::HostServices;
use mon_agent_core::Tool;
use std::sync::Arc;

pub(crate) fn tools(host: HostServices) -> Vec<Arc<dyn Tool>> {
    let mut registered = memo::tools(host.clone());
    registered.extend(memory::tools(host.clone()));
    registered.extend(environment::tools(host.clone()));
    registered.push(self_awake::tool(host));
    registered
}
