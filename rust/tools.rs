use super::*;

pub(crate) fn native_tool_registry(
    workspaces: &WorkspaceService,
    command_tools_enabled: bool,
) -> ToolRegistry {
    let mut registry = ToolRegistry::new();
    for (name, description, parameters, sequential) in [
        (
            "read",
            "Read a UTF-8 file or supported image inside the workspace",
            json!({"type":"object","required":["path"],"properties":{"path":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}}}),
            false,
        ),
        (
            "ls",
            "List a directory inside the workspace",
            json!({"type":"object","properties":{"path":{"type":"string"}}}),
            false,
        ),
        (
            "find",
            "Find files by glob inside the workspace",
            json!({"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"path":{"type":"string"},"limit":{"type":"integer"}}}),
            false,
        ),
        (
            "grep",
            "Search file contents inside the workspace",
            json!({"type":"object","required":["pattern"],"properties":{"pattern":{"type":"string"},"path":{"type":"string"},"glob":{"type":"string"},"limit":{"type":"integer"}}}),
            false,
        ),
        (
            "get_diff",
            "Read a bounded preview of the current Git diff without changing files; narrow path for large diffs",
            json!({"type":"object","properties":{"path":{"type":"string"},"scope":{"type":"string","enum":["working_tree","staged","all"]},"max_chars":{"type":"integer","minimum":1000,"maximum":12000}}}),
            false,
        ),
        (
            "write",
            "Write a file inside the workspace after approval",
            json!({"type":"object","required":["path","content"],"properties":{"path":{"type":"string"},"content":{"type":"string"}}}),
            true,
        ),
        (
            "edit",
            "Apply exact text replacements inside the workspace after approval",
            json!({"type":"object","required":["path"],"properties":{"path":{"type":"string"},"oldText":{"type":"string"},"newText":{"type":"string"},"edits":{"type":"array"}}}),
            true,
        ),
        (
            "apply_patch",
            "Apply a structured file patch inside the workspace after approval",
            json!({"type":"object","required":["patch"],"properties":{"patch":{"type":"string"}}}),
            true,
        ),
    ] {
        let mut definition = ToolDefinition::direct(name, description);
        definition.parameters = parameters;
        if sequential {
            definition.execution_mode = ToolExecutionMode::Sequential;
        }
        if let Some(tool) = workspaces.native_tool(definition) {
            registry.register(tool);
        }
    }
    if command_tools_enabled {
        let command_definitions = if cfg!(windows) {
            vec![(
                "powershell",
                "Run a PowerShell command in the configured OS sandbox",
                json!({"type":"object","required":["command"],"properties":{"command":{"type":"string"},"yield_time_ms":{"type":"integer"}}}),
            )]
        } else {
            vec![(
                "bash",
                "Run a Bash command in the configured OS sandbox",
                json!({"type":"object","required":["command"],"properties":{"command":{"type":"string"},"yield_time_ms":{"type":"integer"}}}),
            )]
        };
        for (name, description, parameters) in command_definitions {
            let mut definition = ToolDefinition::direct(name, description);
            definition.parameters = parameters;
            definition.execution_mode = ToolExecutionMode::Sequential;
            if let Some(tool) = workspaces.native_tool(definition) {
                registry.register(tool);
            }
        }
        let mut definition = ToolDefinition::direct(
            "write_stdin",
            "Poll, write to, or terminate a sandboxed process session",
        );
        definition.parameters = json!({"type":"object","required":["session_id"],"properties":{"session_id":{"type":"string"},"chars":{"type":"string"},"terminate":{"type":"boolean"},"yield_time_ms":{"type":"integer"}}});
        definition.execution_mode = ToolExecutionMode::Sequential;
        if let Some(tool) = workspaces.native_tool(definition) {
            registry.register(tool);
        }
    }
    registry
}
