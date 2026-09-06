CREATE INDEX session_events_sync_projection ON session_events(session_id, seq)
WHERE event_type NOT IN (
    'agent.message_update', 'agent.tool_execution_update',
    'subagent.agent_message_update', 'subagent.agent_tool_execution_update'
) AND instr(event_type, 'delta') = 0 AND instr(event_type, 'thinking') = 0;
